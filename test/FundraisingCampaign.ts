import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { parseEther } from "viem";

describe("FundraisingCampaign", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();

  // Nos testes, a conta que faz o deploy faz o papel da fábrica.
  const [factory, admin, inst1, inst2, donor, outsider] =
    await viem.getWalletClients();

  const GOAL_1 = parseEther("10");
  const GOAL_2 = parseEther("5");

  async function deployCampaign() {
    const campaign = await viem.deployContract("FundraisingCampaign", [
      [inst1.account.address, inst2.account.address],
      [GOAL_1, GOAL_2],
      admin.account.address,
    ]);
    return { campaign };
  }

  // Deploy + 8 ETH no caixa geral
  async function deployFundedCampaign() {
    const { campaign } = await deployCampaign();
    await campaign.write.donateToCampaign({
      account: donor.account,
      value: parseEther("8"),
    });
    return { campaign };
  }

  describe("criação", function () {
    it("registra fábrica, admin, instituições, metas e começa ativa", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployCampaign);

      assert.equal(
        (await campaign.read.factory()).toLowerCase(),
        factory.account.address.toLowerCase(),
      );
      assert.equal(
        (await campaign.read.admin()).toLowerCase(),
        admin.account.address.toLowerCase(),
      );
      assert.equal(await campaign.read.isActive(), true);
      assert.equal(await campaign.read.goals([inst1.account.address]), GOAL_1);
      assert.equal(await campaign.read.campaignGoal(), GOAL_1 + GOAL_2);
      assert.equal((await campaign.read.getParticipants()).length, 2);
    });

    it("rejeita instituições duplicadas", async function () {
      // instância só para o viem conhecer o ABI com os erros
      const { campaign } = await networkHelpers.loadFixture(deployCampaign);

      await viem.assertions.revertWithCustomErrorWithArgs(
        viem.deployContract("FundraisingCampaign", [
          [inst1.account.address, inst1.account.address],
          [GOAL_1, GOAL_2],
          admin.account.address,
        ]),
        campaign,
        "DuplicatedParticipant",
        [inst1.account.address],
      );
    });

    it("rejeita listas de tamanhos diferentes", async function () {
      // instância só para o viem conhecer o ABI com os erros
      const { campaign } = await networkHelpers.loadFixture(deployCampaign);

      await viem.assertions.revertWithCustomErrorWithArgs(
        viem.deployContract("FundraisingCampaign", [
          [inst1.account.address],
          [GOAL_1, GOAL_2],
          admin.account.address,
        ]),
        campaign,
        "LengthMismatch",
        [1n, 2n],
      );
    });
  });

  describe("doações", function () {
    it("doação ao caixa geral recebe ETH e emite evento", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployCampaign);

      await viem.assertions.emitWithArgs(
        campaign.write.donateToCampaign({
          account: donor.account,
          value: parseEther("1"),
        }),
        campaign,
        "DonationReceived",
        [donor.account.address, parseEther("1")],
      );

      assert.equal(await campaign.read.campaignBalance(), parseEther("1"));
      assert.equal(
        await publicClient.getBalance({ address: campaign.address }),
        parseEther("1"),
      );
    });

    it("rejeita doação de valor zero", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployCampaign);

      await viem.assertions.revertWithCustomError(
        campaign.write.donateToCampaign({ account: donor.account, value: 0n }),
        campaign,
        "ZeroAmount",
      );
    });
  });

  describe("alocação", function () {
    it("admin move do caixa geral para a instituição", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);

      await viem.assertions.emitWithArgs(
        campaign.write.allocateDonations(
          [inst1.account.address, parseEther("3")],
          { account: admin.account },
        ),
        campaign,
        "DonationsAllocated",
        [inst1.account.address, parseEther("3")],
      );

      assert.equal(await campaign.read.campaignBalance(), parseEther("5"));
      assert.equal(
        await campaign.read.participantBalance([inst1.account.address]),
        parseEther("3"),
      );
    });

    it("só o admin pode alocar (modifier onlyAdmin)", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.allocateDonations(
          [inst1.account.address, parseEther("1")],
          { account: outsider.account },
        ),
        campaign,
        "NotAdmin",
        [outsider.account.address],
      );
    });

    it("não aloca mais do que o caixa geral tem", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.allocateDonations(
          [inst1.account.address, parseEther("9")],
          { account: admin.account },
        ),
        campaign,
        "InsufficientBalance",
        [parseEther("8"), parseEther("9")],
      );
    });

    it("não aloca além da meta da instituição", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.allocateDonations(
          [inst2.account.address, parseEther("6")], // meta da inst2 é 5
          { account: admin.account },
        ),
        campaign,
        "AllocationExceedsGoal",
        [parseEther("5"), parseEther("6")],
      );
    });
  });

  describe("limite do caixa geral", function () {
    // metas: 10 + 5 = 15 ETH; deployFundedCampaign já doou 8 ao caixa geral

    it("informa quanto ainda pode ser doado ao caixa geral", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);
      assert.equal(await campaign.read.getRemainingToFund(), parseEther("7"));
    });

    it("recusa doação ao caixa geral acima do que falta", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.donateToCampaign({
          account: donor.account,
          value: parseEther("8"),
        }),
        campaign,
        "DonationExceedsRemainingGoal",
        [parseEther("7"), parseEther("8")],
      );
    });

    it("alocar não abre espaço para novas doações", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);
      await campaign.write.allocateDonations(
        [inst1.account.address, parseEther("3")],
        { account: admin.account },
      );

      assert.equal(await campaign.read.totalAllocated(), parseEther("3"));
      assert.equal(await campaign.read.getRemainingToFund(), parseEther("7"));
    });

    it("emite CampaignFullyFunded ao cobrir todas as metas", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);

      await viem.assertions.emitWithArgs(
        campaign.write.donateToCampaign({
          account: donor.account,
          value: parseEther("7"),
        }),
        campaign,
        "CampaignFullyFunded",
        [GOAL_1 + GOAL_2],
      );

      assert.equal(await campaign.read.isFullyFunded(), true);
      assert.equal(await campaign.read.getRemainingToFund(), 0n);
    });

    it("depois de coberta, recusa novas doações", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);
      await campaign.write.donateToCampaign({
        account: donor.account,
        value: parseEther("7"),
      });

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.donateToCampaign({ account: donor.account, value: 1n }),
        campaign,
        "DonationExceedsRemainingGoal",
        [0n, 1n],
      );
    });

    it("redistribuição que cobre o que falta marca a campanha como financiada", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);

      await viem.assertions.emitWithArgs(
        campaign.write.receiveRedistribution({
          account: factory.account,
          value: parseEther("7"),
        }),
        campaign,
        "CampaignFullyFunded",
        [GOAL_1 + GOAL_2],
      );
      assert.equal(await campaign.read.getRemainingToFund(), 0n);
    });

    it("recusa redistribuição acima do que falta", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.receiveRedistribution({
          account: factory.account,
          value: parseEther("10"),
        }),
        campaign,
        "RedistributionExceedsRemainingGoal",
        [parseEther("7"), parseEther("10")],
      );
      assert.equal(await campaign.read.campaignBalance(), parseEther("8"));
    });
  });

  describe("saques e comprovantes", function () {
    async function deployAllocatedCampaign() {
      const { campaign } = await deployFundedCampaign();
      await campaign.write.allocateDonations(
        [inst1.account.address, parseEther("4")],
        { account: admin.account },
      );
      return { campaign };
    }

    it("instituição saca para a própria carteira e o saque fica registrado", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployAllocatedCampaign);

      await viem.assertions.balancesHaveChanged(
        campaign.write.withdraw([parseEther("2"), "Compra de alimentos"], {
          account: inst1.account,
        }),
        [
          { address: inst1.account.address, amount: parseEther("2") },
          { address: campaign.address, amount: -parseEther("2") },
        ],
      );

      assert.equal(
        await campaign.read.participantBalance([inst1.account.address]),
        parseEther("2"),
      );
      assert.equal(await campaign.read.getWithdrawalsCount(), 1n);

      const w = await campaign.read.getWithdrawal([0n]);
      assert.equal(w.amount, parseEther("2"));
      assert.equal(w.description, "Compra de alimentos");
      assert.equal(w.receiptCid, "");
    });

    it("saque emite o evento Withdrawn", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployAllocatedCampaign);

      await viem.assertions.emitWithArgs(
        campaign.write.withdraw([parseEther("1"), "Aluguel"], {
          account: inst1.account,
        }),
        campaign,
        "Withdrawn",
        [0n, inst1.account.address, parseEther("1"), "Aluguel"],
      );
    });

    it("não saca mais do que o saldo da instituição", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployAllocatedCampaign);

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.withdraw([parseEther("5"), "Teste"], {
          account: inst1.account,
        }),
        campaign,
        "InsufficientBalance",
        [parseEther("4"), parseEther("5")],
      );
    });

    it("quem não participa não pode sacar (modifier onlyParticipant)", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployAllocatedCampaign);

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.withdraw([1n, "Teste"], { account: outsider.account }),
        campaign,
        "NotParticipant",
        [outsider.account.address],
      );
    });

    it("exige descrição no saque", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployAllocatedCampaign);

      await viem.assertions.revertWithCustomError(
        campaign.write.withdraw([parseEther("1"), ""], {
          account: inst1.account,
        }),
        campaign,
        "EmptyDescription",
      );
    });

    it("comprovante é registrado uma única vez e só por quem sacou", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployAllocatedCampaign);
      await campaign.write.withdraw([parseEther("1"), "Remédios"], {
        account: inst1.account,
      });

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.registerReceipt([0n, "bafy-cid"], {
          account: inst2.account,
        }),
        campaign,
        "NotWithdrawalOwner",
        [inst2.account.address, 0n],
      );

      await viem.assertions.emitWithArgs(
        campaign.write.registerReceipt([0n, "bafy-cid"], {
          account: inst1.account,
        }),
        campaign,
        "ReceiptRegistered",
        [0n, inst1.account.address, "bafy-cid"],
      );

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.registerReceipt([0n, "outro-cid"], {
          account: inst1.account,
        }),
        campaign,
        "ReceiptAlreadyRegistered",
        [0n],
      );

      const w = await campaign.read.getWithdrawal([0n]);
      assert.equal(w.receiptCid, "bafy-cid");
    });
  });

  describe("funções da fábrica", function () {
    it("fábrica envia redistribuição para o caixa geral", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployCampaign);

      await campaign.write.receiveRedistribution({
        account: factory.account,
        value: parseEther("2"),
      });
      assert.equal(await campaign.read.campaignBalance(), parseEther("2"));
    });
  });

  describe("encerramento", function () {
    async function deployClosedCampaign() {
      const { campaign } = await deployFundedCampaign();
      await campaign.write.allocateDonations(
        [inst1.account.address, parseEther("3")],
        { account: admin.account },
      );
      await campaign.write.close({ account: factory.account });
      return { campaign };
    }

    it("envia o caixa geral para a fábrica e desativa a campanha", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);

      await viem.assertions.balancesHaveChanged(
        campaign.write.close({ account: factory.account }),
        [{ address: campaign.address, amount: -parseEther("8") }],
      );

      assert.equal(await campaign.read.isActive(), false);
      assert.equal(await campaign.read.campaignBalance(), 0n);
    });

    it("só a fábrica encerra", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployFundedCampaign);

      await viem.assertions.revertWithCustomErrorWithArgs(
        campaign.write.close({ account: admin.account }),
        campaign,
        "NotFactory",
        [admin.account.address],
      );
    });

    it("campanha encerrada não aceita doações nem alocações (modifier whenActive)", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployClosedCampaign);

      await viem.assertions.revertWithCustomError(
        campaign.write.donateToCampaign({
          account: donor.account,
          value: parseEther("1"),
        }),
        campaign,
        "CampaignNotActive",
      );
      await viem.assertions.revertWithCustomError(
        campaign.write.allocateDonations([inst1.account.address, 1n], {
          account: admin.account,
        }),
        campaign,
        "CampaignNotActive",
      );
    });

    it("instituição ainda saca o que já era dela depois do encerramento", async function () {
      const { campaign } = await networkHelpers.loadFixture(deployClosedCampaign);

      await campaign.write.withdraw([parseEther("3"), "Saque final"], {
        account: inst1.account,
      });
      assert.equal(
        await campaign.read.participantBalance([inst1.account.address]),
        0n,
      );
    });
  });
});
