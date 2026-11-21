// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

import {FundraisingCampaign} from "./FundraisingCampaign.sol";

/// @title CampaignFactory
/// @notice Contrato principal (Contract Factory). Cadastra instituições e
///         administradores, recebe propostas de campanha, cria os contratos
///         FundraisingCampaign, controla os limites de participação, encerra
///         campanhas e redistribui o caixa geral das encerradas.
contract CampaignFactory {
    enum InstitutionStatus {
        None,
        Pending,
        Verified,
        Revoked
    }

    /// Expired não é gravado: é calculado quando o prazo passa sem decisão.
    enum ProposalStatus {
        Pending,
        Rejected,
        Executed,
        Expired
    }

    struct Institution {
        string cnpj;
        string documentsCid;
        InstitutionStatus status;
    }

    struct Proposal {
        address admin;
        address[] participants;
        uint256[] goals;
        uint256 deadline;
        uint256 approvals;
        ProposalStatus status;
        address campaign; // preenchido quando a campanha é criada
    }

    struct CampaignSummary {
        address campaign;
        address admin;
        bool isActive;
        uint256 campaignBalance;
        uint256 campaignGoal;
        uint256 totalAllocated;
        uint256 remainingToFund;
        address[] participants;
    }

    // ------------------------------------------------------------------
    // Estado
    // ------------------------------------------------------------------

    /// Prazo fixo para as instituições aprovarem ou recusarem a proposta.
    uint256 public constant APPROVAL_PERIOD = 30 days;

    /// Administrador da fábrica.
    address public immutable owner;

    uint256 public maxCampaignsPerAdmin = 2;
    uint256 public maxCampaignsPerParticipant = 2;
    uint256 public maxActiveCampaigns = 20;

    /// Valor aguardando redistribuição (todas as campanhas ativas cobertas).
    uint256 public reserve;

    mapping(address => Institution) public institutions;
    mapping(address => bool) public isRegisteredAdmin;

    Proposal[] private proposals;
    mapping(uint256 => mapping(address => bool)) public isProposalParticipant;
    mapping(uint256 => mapping(address => bool)) public hasApproved;

    address[] private allCampaigns;
    /// Campanhas ativas em ordem de criação (a mais antiga primeiro).
    address[] private activeCampaigns;
    mapping(address => bool) public isCampaign;
    mapping(address => uint256) public activeCampaignsOfAdmin;
    mapping(address => uint256) public activeCampaignsOfParticipant;

    // ------------------------------------------------------------------
    // Eventos
    // ------------------------------------------------------------------

    event InstitutionRegistered(address indexed institution, string cnpj, string documentsCid);
    event InstitutionVerified(address indexed institution, string cnpj, string documentsCid);
    event InstitutionRevoked(address indexed institution, string reason);
    event AdminRegistered(address indexed admin);

    event CampaignProposed(
        uint256 indexed proposalId,
        address indexed admin,
        address[] participants,
        uint256[] goals,
        uint256 deadline
    );
    event ProposalApproved(uint256 indexed proposalId, address indexed institution);
    event ProposalRejected(uint256 indexed proposalId, address indexed institution);
    event CampaignCreated(
        uint256 indexed proposalId,
        address indexed campaign,
        address indexed admin,
        address[] participants
    );

    event LimitsUpdated(uint256 maxCampaignsPerAdmin, uint256 maxCampaignsPerParticipant, uint256 maxActiveCampaigns);
    event CampaignClosed(address indexed campaign, uint256 generalBalance);

    /// source == address(0) quando é a reserva sendo distribuída sem
    /// uma campanha encerrada (nova campanha ou chamada manual).
    event Redistribution(address indexed source, uint256 totalAmount);
    event RedistributionSent(address indexed campaign, uint256 amount);
    event ReserveUpdated(uint256 reserve);

    // ------------------------------------------------------------------
    // Erros
    // ------------------------------------------------------------------

    // Permissão
    error NotOwner(address caller);
    error NotCampaign(address account);
    error NotCampaignAdmin(address caller);
    error NotProposalParticipant(address caller, uint256 proposalId);
    error AdminNotRegistered(address admin);
    error InstitutionNotVerified(address institution);

    // Estado
    error InstitutionAlreadyRegistered(address institution);
    error InvalidInstitutionStatus(address institution, InstitutionStatus status);
    error AdminAlreadyRegistered(address admin);
    error ProposalNotPending(uint256 proposalId, ProposalStatus status);
    error AlreadyApproved(uint256 proposalId, address institution);
    error CampaignNotActive(address campaign);
    error AdminLimitReached(address admin, uint256 limit);
    error ParticipantLimitReached(address institution, uint256 limit);
    error ActiveCampaignsLimitReached(uint256 limit);

    // Entrada inválida
    error InvalidProposalId(uint256 proposalId);
    error NoParticipants();
    error LengthMismatch(uint256 participants, uint256 goals);
    error DuplicatedParticipant(address institution);
    error ZeroGoal(address institution);
    error EmptyField();
    error InvalidLimit();

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, NotOwner(msg.sender));
        _;
    }

    modifier onlyKnownCampaign(address campaign) {
        require(isCampaign[campaign], NotCampaign(campaign));
        _;
    }

    modifier onlyPendingProposal(uint256 proposalId) {
        require(proposalId < proposals.length, InvalidProposalId(proposalId));
        ProposalStatus status = _statusOf(proposalId);
        require(status == ProposalStatus.Pending, ProposalNotPending(proposalId, status));
        _;
    }

    modifier onlyProposalParticipant(uint256 proposalId) {
        require(isProposalParticipant[proposalId][msg.sender], NotProposalParticipant(msg.sender, proposalId));
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Só aceita ETH vindo de campanhas criadas por esta fábrica
    ///         (o caixa geral enviado no encerramento).
    receive() external payable {
        require(isCampaign[msg.sender], NotCampaign(msg.sender));
    }

    // ------------------------------------------------------------------
    // Cadastro (seção 3)
    // ------------------------------------------------------------------

    /// @notice A instituição solicita o próprio cadastro.
    function registerInstitution(string calldata cnpj, string calldata documentsCid) external {
        Institution storage inst = institutions[msg.sender];
        require(inst.status == InstitutionStatus.None, InstitutionAlreadyRegistered(msg.sender));
        require(bytes(cnpj).length > 0 && bytes(documentsCid).length > 0, EmptyField());

        inst.cnpj = cnpj;
        inst.documentsCid = documentsCid;
        inst.status = InstitutionStatus.Pending;
        emit InstitutionRegistered(msg.sender, cnpj, documentsCid);
    }

    /// @notice O admin da fábrica verifica a instituição depois de conferir
    ///         os documentos fora da blockchain. Também reativa uma revogada.
    function verifyInstitution(address institution) external onlyOwner {
        Institution storage inst = institutions[institution];
        require(
            inst.status == InstitutionStatus.Pending || inst.status == InstitutionStatus.Revoked,
            InvalidInstitutionStatus(institution, inst.status)
        );

        inst.status = InstitutionStatus.Verified;
        emit InstitutionVerified(institution, inst.cnpj, inst.documentsCid);
    }

    /// @notice Revoga a verificação. A instituição não entra em novas
    ///         campanhas, mas continua nas que já participa.
    function revokeInstitution(address institution, string calldata reason) external onlyOwner {
        Institution storage inst = institutions[institution];
        require(inst.status == InstitutionStatus.Verified, InvalidInstitutionStatus(institution, inst.status));
        require(bytes(reason).length > 0, EmptyField());

        inst.status = InstitutionStatus.Revoked;
        emit InstitutionRevoked(institution, reason);
    }

    /// @notice Cadastro de administrador de campanha (regra 3.5).
    function registerAdmin() external {
        require(!isRegisteredAdmin[msg.sender], AdminAlreadyRegistered(msg.sender));
        isRegisteredAdmin[msg.sender] = true;
        emit AdminRegistered(msg.sender);
    }

    // ------------------------------------------------------------------
    // Propostas e criação (seção 4)
    // ------------------------------------------------------------------

    /// @notice O candidato a admin propõe uma campanha. O prazo de aprovação
    ///         é fixo (APPROVAL_PERIOD).
    function proposeCampaign(
        address[] calldata participants,
        uint256[] calldata goals
    ) external returns (uint256 proposalId) {
        require(isRegisteredAdmin[msg.sender], AdminNotRegistered(msg.sender));
        require(participants.length > 0, NoParticipants());
        require(participants.length == goals.length, LengthMismatch(participants.length, goals.length));

        proposalId = proposals.length;
        Proposal storage p = proposals.push();

        for (uint256 i = 0; i < participants.length; i++) {
            address inst = participants[i];
            require(institutions[inst].status == InstitutionStatus.Verified, InstitutionNotVerified(inst));
            require(goals[i] > 0, ZeroGoal(inst));
            require(!isProposalParticipant[proposalId][inst], DuplicatedParticipant(inst));
            isProposalParticipant[proposalId][inst] = true;
        }

        p.admin = msg.sender;
        p.participants = participants;
        p.goals = goals;
        p.deadline = block.timestamp + APPROVAL_PERIOD;
        p.status = ProposalStatus.Pending;

        emit CampaignProposed(proposalId, msg.sender, participants, goals, p.deadline);
    }

    /// @notice A instituição aprova a proposta. A última aprovação cria a
    ///         campanha; se algum limite estiver estourado nesse momento, a
    ///         aprovação reverte e pode ser repetida depois, dentro do prazo.
    function approveProposal(uint256 proposalId)
        external
        onlyPendingProposal(proposalId)
        onlyProposalParticipant(proposalId)
    {
        require(!hasApproved[proposalId][msg.sender], AlreadyApproved(proposalId, msg.sender));
        require(institutions[msg.sender].status == InstitutionStatus.Verified, InstitutionNotVerified(msg.sender));

        Proposal storage p = proposals[proposalId];
        hasApproved[proposalId][msg.sender] = true;
        p.approvals++;
        emit ProposalApproved(proposalId, msg.sender);

        if (p.approvals == p.participants.length) {
            _createCampaign(proposalId);
        }
    }

    /// @notice Qualquer instituição listada pode recusar, cancelando a proposta.
    function rejectProposal(uint256 proposalId)
        external
        onlyPendingProposal(proposalId)
        onlyProposalParticipant(proposalId)
    {
        proposals[proposalId].status = ProposalStatus.Rejected;
        emit ProposalRejected(proposalId, msg.sender);
    }

    function _createCampaign(uint256 proposalId) internal {
        Proposal storage p = proposals[proposalId];

        // Limites verificados no momento da criação (regra 5.5)
        require(activeCampaigns.length < maxActiveCampaigns, ActiveCampaignsLimitReached(maxActiveCampaigns));
        require(
            activeCampaignsOfAdmin[p.admin] < maxCampaignsPerAdmin,
            AdminLimitReached(p.admin, maxCampaignsPerAdmin)
        );
        for (uint256 i = 0; i < p.participants.length; i++) {
            address inst = p.participants[i];
            require(institutions[inst].status == InstitutionStatus.Verified, InstitutionNotVerified(inst));
            require(
                activeCampaignsOfParticipant[inst] < maxCampaignsPerParticipant,
                ParticipantLimitReached(inst, maxCampaignsPerParticipant)
            );
            activeCampaignsOfParticipant[inst]++;
        }
        activeCampaignsOfAdmin[p.admin]++;

        FundraisingCampaign campaign = new FundraisingCampaign(p.participants, p.goals, p.admin);
        address addr = address(campaign);

        p.status = ProposalStatus.Executed;
        p.campaign = addr;
        isCampaign[addr] = true;
        allCampaigns.push(addr);
        activeCampaigns.push(addr);

        emit CampaignCreated(proposalId, addr, p.admin, p.participants);

        // Regra 11.6: a reserva é distribuída sempre que surge uma campanha
        _distributeReserve(address(0));
    }

    // ------------------------------------------------------------------
    // Gestão das campanhas (seção 11)
    // ------------------------------------------------------------------

    /// @notice O admin da campanha a encerra por meio da fábrica.
    function closeCampaign(address campaignAddr) external onlyKnownCampaign(campaignAddr) {
        FundraisingCampaign campaign = FundraisingCampaign(campaignAddr);
        address campaignAdmin = campaign.admin();
        require(msg.sender == campaignAdmin, NotCampaignAdmin(msg.sender));
        require(campaign.isActive(), CampaignNotActive(campaignAddr));

        // A campanha envia o caixa geral para esta fábrica (receive)
        uint256 amount = campaign.close();

        _removeFromActive(campaignAddr);
        activeCampaignsOfAdmin[campaignAdmin]--;
        address[] memory participants = campaign.getParticipants();
        for (uint256 i = 0; i < participants.length; i++) {
            activeCampaignsOfParticipant[participants[i]]--;
        }

        emit CampaignClosed(campaignAddr, amount);

        reserve += amount;
        _distributeReserve(campaignAddr);
    }

    function setLimits(uint256 perAdmin, uint256 perParticipant, uint256 activeTotal) external onlyOwner {
        require(perAdmin > 0 && perParticipant > 0 && activeTotal > 0, InvalidLimit());
        maxCampaignsPerAdmin = perAdmin;
        maxCampaignsPerParticipant = perParticipant;
        maxActiveCampaigns = activeTotal;
        emit LimitsUpdated(perAdmin, perParticipant, activeTotal);
    }

    /// @notice Qualquer pessoa pode acionar a distribuição da reserva.
    function distributeReserve() external {
        _distributeReserve(address(0));
    }

    // ------------------------------------------------------------------
    // Redistribuição (seção 11)
    // ------------------------------------------------------------------

    /// @dev Percorre as campanhas ativas da mais antiga para a mais nova.
    ///      Cada uma recebe no máximo o que lhe falta; o que sobrar volta
    ///      para a reserva. O loop é limitado por maxActiveCampaigns.
    function _distributeReserve(address source) internal {
        uint256 fund = reserve;
        if (fund == 0) return;

        reserve = 0; // efeitos antes das chamadas externas
        emit Redistribution(source, fund);

        for (uint256 i = 0; i < activeCampaigns.length && fund > 0; i++) {
            FundraisingCampaign campaign = FundraisingCampaign(activeCampaigns[i]);
            uint256 remaining = campaign.getRemainingToFund();
            if (remaining == 0) continue;

            uint256 amount = remaining < fund ? remaining : fund;
            fund -= amount;
            campaign.receiveRedistribution{value: amount}();
            emit RedistributionSent(address(campaign), amount);
        }

        reserve = fund;
        emit ReserveUpdated(fund);
    }

    /// @dev Remove mantendo a ordem de criação (desloca os elementos).
    function _removeFromActive(address campaignAddr) internal {
        uint256 len = activeCampaigns.length;
        for (uint256 i = 0; i < len; i++) {
            if (activeCampaigns[i] == campaignAddr) {
                for (uint256 j = i; j + 1 < len; j++) {
                    activeCampaigns[j] = activeCampaigns[j + 1];
                }
                activeCampaigns.pop();
                return;
            }
        }
    }

    // ------------------------------------------------------------------
    // Consultas (seção 12)
    // ------------------------------------------------------------------

    function _statusOf(uint256 proposalId) internal view returns (ProposalStatus) {
        Proposal storage p = proposals[proposalId];
        if (p.status == ProposalStatus.Pending && block.timestamp > p.deadline) {
            return ProposalStatus.Expired;
        }
        return p.status;
    }

    function getProposalsCount() external view returns (uint256) {
        return proposals.length;
    }

    function getProposal(uint256 proposalId) external view returns (Proposal memory proposal) {
        require(proposalId < proposals.length, InvalidProposalId(proposalId));
        proposal = proposals[proposalId];
        proposal.status = _statusOf(proposalId);
    }

    function getAllCampaigns() external view returns (address[] memory) {
        return allCampaigns;
    }

    function getActiveCampaigns() external view returns (address[] memory) {
        return activeCampaigns;
    }

    /// @notice Consulta os dados de uma campanha chamando o próprio contrato
    ///         dela (interação fábrica -> campanha).
    function getCampaignSummary(address campaignAddr)
        external
        view
        onlyKnownCampaign(campaignAddr)
        returns (CampaignSummary memory summary)
    {
        FundraisingCampaign campaign = FundraisingCampaign(campaignAddr);
        summary.campaign = campaignAddr;
        summary.admin = campaign.admin();
        summary.isActive = campaign.isActive();
        summary.campaignBalance = campaign.campaignBalance();
        summary.campaignGoal = campaign.campaignGoal();
        summary.totalAllocated = campaign.totalAllocated();
        summary.remainingToFund = campaign.getRemainingToFund();
        summary.participants = campaign.getParticipants();
    }
}
