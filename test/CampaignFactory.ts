import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { getAddress, parseEther } from "viem";

// ProposalStatus no contrato
const PENDING = 0;
const REJECTED = 1;
const EXECUTED = 2;
const EXPIRED = 3;

// InstitutionStatus no contrato
const VERIFIED = 2;
const REVOKED = 3;

describe("CampaignFactory", async function () {
  const { viem, networkHelpers } = await network.create();

  const [owner, admin1, admin2, inst1, inst2, inst3, donor, outsider] =
    await viem.getWalletClients();

  // ------------------------------------------------------------------
  // Fixtures e helpers
  // ------------------------------------------------------------------

  /// Fábrica com 3 instituições verificadas e 2 admins cadastrados.
  async function deployFactory() {
    const factory = await viem.deployContract("CampaignFactory");

    for (const [i, inst] of [inst1, inst2, inst3].entries()) {
      await factory.write.registerInstitution([`cnpj-${i}`, `cid-${i}`], {
        account: inst.account,
      });
      await factory.write.verifyInstitution([inst.account.address]);
    }
    for (const a of [admin1, admin2]) {
      await factory.write.registerAdmin({ account: a.account });
    }
    return { factory };
  }

  type Factory = Awaited<ReturnType<typeof deployFactory>>["factory"];
  type Wallet = (typeof inst1);

  /// Propõe e aprova uma campanha; devolve o contrato da campanha criada.
  async function createCampaign(
    factory: Factory,
    admin: Wallet,
    insts: Wallet[],
    goals: bigint[],
  ) {
    await factory.write.proposeCampaign(
      [insts.map((i) => i.account.address), goals],
      { account: admin.account },
    );
    const proposalId = (await factory.read.getProposalsCount()) - 1n;
    for (const inst of insts) {
      await factory.write.approveProposal([proposalId], {
        account: inst.account,
      });
    }
    const proposal = await factory.read.getProposal([proposalId]);
    return viem.getContractAt("FundraisingCampaign", proposal.campaign);
  }

  /// Duas campanhas: A (mais antiga, meta 10) e B (meta 10).
  async function deployTwoCampaigns() {
    const { factory } = await deployFactory();
    const campaignA = await createCampaign(factory, admin1, [inst1], [
      parseEther("10"),
    ]);
    const campaignB = await createCampaign(factory, admin2, [inst2], [
      parseEther("10"),
    ]);
    return { factory, campaignA, campaignB };
  }

  // ------------------------------------------------------------------
  // Cadastro
  // ------------------------------------------------------------------

  describe("cadastro de instituições e admins", function () {
    it("instituição se cadastra como pendente e o dono verifica", async function () {
      const factory = await viem.deployContract("CampaignFactory");

      await viem.assertions.emitWithArgs(
        factory.write.registerInstitution(["12.345/0001-00", "bafy-docs"], {
          account: inst1.account,
        }),
        factory,
        "InstitutionRegistered",
        [getAddress(inst1.account.address), "12.345/0001-00", "bafy-docs"],
      );

      await viem.assertions.emitWithArgs(
        factory.write.verifyInstitution([inst1.account.address]),
        factory,
        "InstitutionVerified",
        [getAddress(inst1.account.address), "12.345/0001-00", "bafy-docs"],
      );

      const [cnpj, cid, status] = await factory.read.institutions([
        inst1.account.address,
      ]);
      assert.equal(cnpj, "12.345/0001-00");
      assert.equal(cid, "bafy-docs");
      assert.equal(status, VERIFIED);
    });

    it("só o dono verifica instituições (modifier onlyOwner)", async function () {
      const factory = await viem.deployContract("CampaignFactory");
      await factory.write.registerInstitution(["cnpj", "cid"], {
        account: inst1.account,
      });

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.verifyInstitution([inst1.account.address], {
          account: outsider.account,
        }),
        factory,
        "NotOwner",
        [getAddress(outsider.account.address)],
      );
    });

    it("instituição não se cadastra duas vezes", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.registerInstitution(["x", "y"], {
          account: inst1.account,
        }),
        factory,
        "InstitutionAlreadyRegistered",
        [getAddress(inst1.account.address)],
      );
    });

    it("dono revoga a verificação informando o motivo", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);

      await viem.assertions.emitWithArgs(
        factory.write.revokeInstitution([inst1.account.address, "fraude"]),
        factory,
        "InstitutionRevoked",
        [getAddress(inst1.account.address), "fraude"],
      );
      const [, , status] = await factory.read.institutions([
        inst1.account.address,
      ]);
      assert.equal(status, REVOKED);
    });
  });

  // ------------------------------------------------------------------
  // Propostas
  // ------------------------------------------------------------------

  describe("propostas", function () {
    it("admin não cadastrado não pode propor", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.proposeCampaign(
          [[inst1.account.address], [parseEther("1")]],
          { account: outsider.account },
        ),
        factory,
        "AdminNotRegistered",
        [getAddress(outsider.account.address)],
      );
    });

    it("não aceita instituição não verificada", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.proposeCampaign(
          [[outsider.account.address], [parseEther("1")]],
          { account: admin1.account },
        ),
        factory,
        "InstitutionNotVerified",
        [getAddress(outsider.account.address)],
      );
    });

    it("não aceita instituição repetida", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.proposeCampaign(
          [
            [inst1.account.address, inst1.account.address],
            [parseEther("1"), parseEther("1")],
          ],
          { account: admin1.account },
        ),
        factory,
        "DuplicatedParticipant",
        [getAddress(inst1.account.address)],
      );
    });

    it("campanha só é criada depois que todas as instituições aprovam", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);
      await factory.write.proposeCampaign(
        [
          [inst1.account.address, inst2.account.address],
          [parseEther("10"), parseEther("5")],
        ],
        { account: admin1.account },
      );

      await viem.assertions.emitWithArgs(
        factory.write.approveProposal([0n], { account: inst1.account }),
        factory,
        "ProposalApproved",
        [0n, getAddress(inst1.account.address)],
      );
      assert.equal((await factory.read.getAllCampaigns()).length, 0);

      await viem.assertions.emit(
        factory.write.approveProposal([0n], { account: inst2.account }),
        factory,
        "CampaignCreated",
      );

      const proposal = await factory.read.getProposal([0n]);
      assert.equal(proposal.status, EXECUTED);

      const campaign = await viem.getContractAt(
        "FundraisingCampaign",
        proposal.campaign,
      );
      assert.equal(
        getAddress(await campaign.read.factory()),
        getAddress(factory.address),
      );
      assert.equal(
        getAddress(await campaign.read.admin()),
        getAddress(admin1.account.address),
      );
      assert.equal(await campaign.read.campaignGoal(), parseEther("15"));
      assert.equal(await factory.read.isCampaign([proposal.campaign]), true);
    });

    it("quem não está na proposta não aprova", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);
      await factory.write.proposeCampaign(
        [[inst1.account.address], [parseEther("1")]],
        { account: admin1.account },
      );

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.approveProposal([0n], { account: inst2.account }),
        factory,
        "NotProposalParticipant",
        [getAddress(inst2.account.address), 0n],
      );
    });

    it("instituição não aprova duas vezes", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);
      await factory.write.proposeCampaign(
        [
          [inst1.account.address, inst2.account.address],
          [parseEther("1"), parseEther("1")],
        ],
        { account: admin1.account },
      );
      await factory.write.approveProposal([0n], { account: inst1.account });

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.approveProposal([0n], { account: inst1.account }),
        factory,
        "AlreadyApproved",
        [0n, getAddress(inst1.account.address)],
      );
    });

    it("uma recusa cancela a proposta", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);
      await factory.write.proposeCampaign(
        [
          [inst1.account.address, inst2.account.address],
          [parseEther("1"), parseEther("1")],
        ],
        { account: admin1.account },
      );

      await viem.assertions.emitWithArgs(
        factory.write.rejectProposal([0n], { account: inst2.account }),
        factory,
        "ProposalRejected",
        [0n, getAddress(inst2.account.address)],
      );
      assert.equal((await factory.read.getProposal([0n])).status, REJECTED);

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.approveProposal([0n], { account: inst1.account }),
        factory,
        "ProposalNotPending",
        [0n, REJECTED],
      );
    });

    it("proposta expira se o prazo fixo passar sem todas as aprovações", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);
      const period = await factory.read.APPROVAL_PERIOD();
      await factory.write.proposeCampaign(
        [[inst1.account.address], [parseEther("1")]],
        { account: admin1.account },
      );
      const pending = await factory.read.getProposal([0n]);
      assert.equal(pending.status, PENDING);
      assert.equal(
        pending.deadline,
        BigInt(await networkHelpers.time.latest()) + period,
      );

      await networkHelpers.time.increase(period + 1n);

      assert.equal((await factory.read.getProposal([0n])).status, EXPIRED);
      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.approveProposal([0n], { account: inst1.account }),
        factory,
        "ProposalNotPending",
        [0n, EXPIRED],
      );
    });

    it("instituição revogada depois da proposta impede a criação", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);
      await factory.write.proposeCampaign(
        [[inst1.account.address], [parseEther("1")]],
        { account: admin1.account },
      );
      await factory.write.revokeInstitution([inst1.account.address, "fraude"]);

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.approveProposal([0n], { account: inst1.account }),
        factory,
        "InstitutionNotVerified",
        [getAddress(inst1.account.address)],
      );
    });
  });

  // ------------------------------------------------------------------
  // Limites
  // ------------------------------------------------------------------

  describe("limites de participação", function () {
    it("admin não passa de N campanhas ativas", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);
      await createCampaign(factory, admin1, [inst1], [parseEther("1")]);
      await createCampaign(factory, admin1, [inst2], [parseEther("1")]);

      await factory.write.proposeCampaign(
        [[inst3.account.address], [parseEther("1")]],
        { account: admin1.account },
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.approveProposal([2n], { account: inst3.account }),
        factory,
        "AdminLimitReached",
        [getAddress(admin1.account.address), 2n],
      );
    });

    it("instituição não passa de M campanhas ativas", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);
      await createCampaign(factory, admin1, [inst1], [parseEther("1")]);
      await createCampaign(factory, admin2, [inst1], [parseEther("1")]);

      await factory.write.registerAdmin({ account: outsider.account });
      await factory.write.proposeCampaign(
        [[inst1.account.address], [parseEther("1")]],
        { account: outsider.account },
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.approveProposal([2n], { account: inst1.account }),
        factory,
        "ParticipantLimitReached",
        [getAddress(inst1.account.address), 2n],
      );
    });

    it("fábrica não passa de K campanhas ativas", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);
      await factory.write.setLimits([2n, 2n, 1n]);
      await createCampaign(factory, admin1, [inst1], [parseEther("1")]);

      await factory.write.proposeCampaign(
        [[inst2.account.address], [parseEther("1")]],
        { account: admin2.account },
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.approveProposal([1n], { account: inst2.account }),
        factory,
        "ActiveCampaignsLimitReached",
        [1n],
      );
    });

    it("encerrar uma campanha libera os limites", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);
      const campaign = await createCampaign(factory, admin1, [inst1], [
        parseEther("1"),
      ]);
      assert.equal(
        await factory.read.activeCampaignsOfAdmin([admin1.account.address]),
        1n,
      );

      await factory.write.closeCampaign([campaign.address], {
        account: admin1.account,
      });

      assert.equal(
        await factory.read.activeCampaignsOfAdmin([admin1.account.address]),
        0n,
      );
      assert.equal(
        await factory.read.activeCampaignsOfParticipant([inst1.account.address]),
        0n,
      );
      assert.equal((await factory.read.getActiveCampaigns()).length, 0);
    });
  });

  // ------------------------------------------------------------------
  // Encerramento e redistribuição
  // ------------------------------------------------------------------

  describe("encerramento e redistribuição", function () {
    it("só o admin da campanha a encerra", async function () {
      const { factory, campaignA } =
        await networkHelpers.loadFixture(deployTwoCampaigns);

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.closeCampaign([campaignA.address], {
          account: admin2.account,
        }),
        factory,
        "NotCampaignAdmin",
        [getAddress(admin2.account.address)],
      );
    });

    it("não encerra um endereço que não é campanha da fábrica", async function () {
      const { factory } = await networkHelpers.loadFixture(deployTwoCampaigns);

      await viem.assertions.revertWithCustomErrorWithArgs(
        factory.write.closeCampaign([outsider.account.address], {
          account: admin1.account,
        }),
        factory,
        "NotCampaign",
        [getAddress(outsider.account.address)],
      );
    });

    it("caixa geral vai para a campanha ativa mais antiga, até o que falta", async function () {
      const { factory, campaignA, campaignB } =
        await networkHelpers.loadFixture(deployTwoCampaigns);
      const campaignC = await createCampaign(factory, admin1, [inst3], [
        parseEther("10"),
      ]);

      // A já tem 6 (faltam 4); B e C estão vazias (faltam 10 cada)
      await campaignA.write.donateToCampaign({
        account: donor.account,
        value: parseEther("6"),
      });
      // C recebe 9 e é encerrada: os 9 vão para A (4) e depois B (5)
      await campaignC.write.donateToCampaign({
        account: donor.account,
        value: parseEther("9"),
      });

      await viem.assertions.emitWithArgs(
        factory.write.closeCampaign([campaignC.address], {
          account: admin1.account,
        }),
        factory,
        "Redistribution",
        [getAddress(campaignC.address), parseEther("9")],
      );

      assert.equal(await campaignA.read.campaignBalance(), parseEther("10"));
      assert.equal(await campaignA.read.isFullyFunded(), true);
      assert.equal(await campaignB.read.campaignBalance(), parseEther("5"));
      assert.equal(await factory.read.reserve(), 0n);
    });

    it("sobra fica na reserva quando todas as ativas estão cobertas", async function () {
      const { factory, campaignA, campaignB } =
        await networkHelpers.loadFixture(deployTwoCampaigns);

      await campaignA.write.donateToCampaign({
        account: donor.account,
        value: parseEther("10"),
      });
      await campaignB.write.donateToCampaign({
        account: donor.account,
        value: parseEther("10"),
      });

      await viem.assertions.balancesHaveChanged(
        factory.write.closeCampaign([campaignB.address], {
          account: admin2.account,
        }),
        [
          { address: campaignB.address, amount: -parseEther("10") },
          { address: factory.address, amount: parseEther("10") },
        ],
      );
      assert.equal(await factory.read.reserve(), parseEther("10"));
    });

    it("reserva é distribuída quando uma nova campanha é criada", async function () {
      const { factory, campaignA, campaignB } =
        await networkHelpers.loadFixture(deployTwoCampaigns);
      await campaignA.write.donateToCampaign({
        account: donor.account,
        value: parseEther("10"),
      });
      await campaignB.write.donateToCampaign({
        account: donor.account,
        value: parseEther("3"),
      });
      await factory.write.closeCampaign([campaignB.address], {
        account: admin2.account,
      });
      assert.equal(await factory.read.reserve(), parseEther("3"));

      const campaignC = await createCampaign(factory, admin2, [inst3], [
        parseEther("10"),
      ]);

      assert.equal(await campaignC.read.campaignBalance(), parseEther("3"));
      assert.equal(await factory.read.reserve(), 0n);
    });

    it("instituição saca o que já era dela depois do encerramento pela fábrica", async function () {
      const { factory, campaignA } =
        await networkHelpers.loadFixture(deployTwoCampaigns);
      await campaignA.write.donateToCampaign({
        account: donor.account,
        value: parseEther("5"),
      });
      await campaignA.write.allocateDonations(
        [inst1.account.address, parseEther("2")],
        { account: admin1.account },
      );
      await factory.write.closeCampaign([campaignA.address], {
        account: admin1.account,
      });

      await viem.assertions.balancesHaveChanged(
        campaignA.write.withdraw([parseEther("2"), "Saque final"], {
          account: inst1.account,
        }),
        [{ address: inst1.account.address, amount: parseEther("2") }],
      );
    });

    it("fábrica recusa ETH que não vem de uma campanha", async function () {
      const { factory } = await networkHelpers.loadFixture(deployFactory);

      await viem.assertions.revertWithCustomErrorWithArgs(
        outsider.sendTransaction({
          to: factory.address,
          value: parseEther("1"),
        }),
        factory,
        "NotCampaign",
        [getAddress(outsider.account.address)],
      );
    });
  });

  // ------------------------------------------------------------------
  // Consultas
  // ------------------------------------------------------------------

  describe("consultas", function () {
    it("resumo da campanha é lido chamando o contrato da campanha", async function () {
      const { factory, campaignA } =
        await networkHelpers.loadFixture(deployTwoCampaigns);
      await campaignA.write.donateToCampaign({
        account: donor.account,
        value: parseEther("4"),
      });
      await campaignA.write.allocateDonations(
        [inst1.account.address, parseEther("1")],
        { account: admin1.account },
      );

      const summary = await factory.read.getCampaignSummary([
        campaignA.address,
      ]);
      assert.equal(getAddress(summary.admin), getAddress(admin1.account.address));
      assert.equal(summary.isActive, true);
      assert.equal(summary.campaignBalance, parseEther("3"));
      assert.equal(summary.totalAllocated, parseEther("1"));
      assert.equal(summary.campaignGoal, parseEther("10"));
      assert.equal(summary.remainingToFund, parseEther("6"));
      assert.deepEqual(summary.participants.map((a) => getAddress(a)), [
        getAddress(inst1.account.address),
      ]);
    });

    it("lista campanhas ativas em ordem de criação", async function () {
      const { factory, campaignA, campaignB } =
        await networkHelpers.loadFixture(deployTwoCampaigns);

      assert.deepEqual((await factory.read.getActiveCampaigns()).map((a) => getAddress(a)), [
        getAddress(campaignA.address),
        getAddress(campaignB.address),
      ]);
    });
  });
});
