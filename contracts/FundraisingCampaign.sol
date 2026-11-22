// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.34;

contract FundraisingCampaign {
    struct Withdrawal {
        address participant;
        uint256 amount;
        string description;
        string receiptCid; // CID (IPFS) ou hash do comprovante; vazio até ser registrado
        uint256 timestamp;
    }

    // ------------------------------------------------------------------
    // Estado
    // ------------------------------------------------------------------

    address public immutable factory;
    /// Definido na criação e imutável: a fábrica não troca o administrador.
    address public immutable admin;
    bool public isActive;

    address[] private participants;
    mapping(address => bool) public isParticipant;
    mapping(address => uint256) public goals;

    /// Total alocado pelo admin para cada instituição (limitado pela meta).
    mapping(address => uint256) public allocatedDonations;
    /// Saldo atual do caixa de cada instituição.
    mapping(address => uint256) public participantBalance;

    /// Saldo atual do caixa geral.
    uint256 public campaignBalance;
    /// Soma das metas de todas as instituições.
    uint256 public campaignGoal;
    /// Soma de tudo que o admin já alocou (nunca diminui).
    uint256 public totalAllocated;
    /// Vira true quando caixa geral + total alocado cobrem a meta da campanha.
    bool public isFullyFunded;

    Withdrawal[] private withdrawals;

    // ------------------------------------------------------------------
    // Eventos
    // ------------------------------------------------------------------

    event DonationReceived(address indexed donor, uint256 amount);
    event DonationsAllocated(address indexed participant, uint256 amount);
    event Withdrawn(uint256 indexed withdrawalId, address indexed participant, uint256 amount, string description);
    event ReceiptRegistered(uint256 indexed withdrawalId, address indexed participant, string receiptCid);
    event RedistributionReceived(uint256 amount);
    event CampaignClosed(uint256 generalBalanceSentToFactory);
    event CampaignFullyFunded(uint256 campaignGoal);

    // ------------------------------------------------------------------
    // Erros
    // ------------------------------------------------------------------

    // Permissão: quem chamou não pode executar a ação
    error NotAdmin(address caller);
    error NotFactory(address caller);
    error NotParticipant(address account);
    error NotWithdrawalOwner(address caller, uint256 withdrawalId);

    // Estado: a ação não é possível na situação atual
    error CampaignNotActive();
    error ReceiptAlreadyRegistered(uint256 withdrawalId);
    error TransferFailed(address to, uint256 amount);

    // Entrada inválida: parâmetros incorretos
    error NoParticipants();
    error LengthMismatch(uint256 participants, uint256 goals);
    error InvalidAddress();
    error DuplicatedParticipant(address participant);
    error ZeroGoal(address participant);
    error ZeroAmount();
    error EmptyDescription();
    error EmptyReceipt();
    error InvalidWithdrawalId(uint256 withdrawalId);
    error InsufficientBalance(uint256 available, uint256 requested);
    error AllocationExceedsGoal(uint256 remainingGoal, uint256 requested);
    error DonationExceedsRemainingGoal(uint256 remaining, uint256 requested);
    error RedistributionExceedsRemainingGoal(uint256 remaining, uint256 requested);

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier onlyAdmin() {
        require(msg.sender == admin, NotAdmin(msg.sender));
        _;
    }

    modifier onlyFactory() {
        require(msg.sender == factory, NotFactory(msg.sender));
        _;
    }

    modifier onlyParticipant() {
        require(isParticipant[msg.sender], NotParticipant(msg.sender));
        _;
    }

    modifier whenActive() {
        require(isActive, CampaignNotActive());
        _;
    }

    // ------------------------------------------------------------------
    // Construtor
    // ------------------------------------------------------------------

    /// @dev Deve ser chamado pela fábrica, depois de verificar as instituições,
    ///      as aprovações e os limites de participação.
    constructor(
        address[] memory _participants,
        uint256[] memory _goals,
        address _admin
    ) {
        require(_participants.length > 0, NoParticipants());
        require(_participants.length == _goals.length, LengthMismatch(_participants.length, _goals.length));
        require(_admin != address(0), InvalidAddress());

        for (uint256 i = 0; i < _participants.length; i++) {
            address p = _participants[i];
            require(p != address(0), InvalidAddress());
            require(!isParticipant[p], DuplicatedParticipant(p));
            require(_goals[i] > 0, ZeroGoal(p));

            isParticipant[p] = true;
            goals[p] = _goals[i];
            campaignGoal += _goals[i];
            participants.push(p);
        }

        factory = msg.sender;
        admin = _admin;
        isActive = true;
    }

    // ------------------------------------------------------------------
    // Doações (qualquer endereço)
    // ------------------------------------------------------------------

    /// @notice Doa para o caixa geral. Só é aceito até o valor que ainda falta
    ///         para cobrir as metas de todas as instituições
    ///         (meta da campanha - total alocado - caixa geral).
    function donateToCampaign() external payable whenActive {
        require(msg.value > 0, ZeroAmount());
        uint256 remaining = getRemainingToFund();
        require(msg.value <= remaining, DonationExceedsRemainingGoal(remaining, msg.value));

        campaignBalance += msg.value;
        emit DonationReceived(msg.sender, msg.value);
        _checkFullyFunded();
    }

    // ------------------------------------------------------------------
    // Admin da campanha
    // ------------------------------------------------------------------

    function allocateDonations(address participant, uint256 amount) external onlyAdmin whenActive {
        require(amount > 0, ZeroAmount());
        require(isParticipant[participant], NotParticipant(participant));
        require(amount <= campaignBalance, InsufficientBalance(campaignBalance, amount));
        uint256 remainingGoal = goals[participant] - allocatedDonations[participant];
        require(amount <= remainingGoal, AllocationExceedsGoal(remainingGoal, amount));

        campaignBalance -= amount;
        totalAllocated += amount;
        allocatedDonations[participant] += amount;
        participantBalance[participant] += amount;
        emit DonationsAllocated(participant, amount);
    }

    // ------------------------------------------------------------------
    // Instituições
    // ------------------------------------------------------------------

    /// @notice Saca recursos do caixa da instituição. Permitido mesmo depois
    ///         do encerramento, para o saldo que já pertencia à instituição.
    /// @dev Uso esperado: sacar a porção de um gasto específico (não o saldo
    ///      inteiro de uma vez) e depois anexar o comprovante desse gasto em
    ///      registerReceipt. Cada saque aceita um único comprovante.
    /// @return withdrawalId identificador usado depois em registerReceipt.
    function withdraw(uint256 amount, string calldata description)
        external
        onlyParticipant
        returns (uint256 withdrawalId)
    {
        require(amount > 0, ZeroAmount());
        require(bytes(description).length > 0, EmptyDescription());
        require(participantBalance[msg.sender] >= amount, InsufficientBalance(participantBalance[msg.sender], amount));

        // checks-effects-interactions: atualiza o estado antes de transferir
        participantBalance[msg.sender] -= amount;
        withdrawalId = withdrawals.length;
        withdrawals.push(Withdrawal(msg.sender, amount, description, "", block.timestamp));
        emit Withdrawn(withdrawalId, msg.sender, amount, description);

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, TransferFailed(msg.sender, amount));
    }

    /// @notice Vincula o comprovante (CID do IPFS ou hash) a um saque.
    ///         Só pode ser registrado uma vez, para que não seja trocado depois.
    function registerReceipt(uint256 withdrawalId, string calldata receiptCid) external {
        require(withdrawalId < withdrawals.length, InvalidWithdrawalId(withdrawalId));
        require(bytes(receiptCid).length > 0, EmptyReceipt());
        
        Withdrawal storage w = withdrawals[withdrawalId];
        require(msg.sender == w.participant, NotWithdrawalOwner(msg.sender, withdrawalId));
        require(bytes(w.receiptCid).length == 0, ReceiptAlreadyRegistered(withdrawalId));

        w.receiptCid = receiptCid;
        emit ReceiptRegistered(withdrawalId, msg.sender, receiptCid);
    }

    // ------------------------------------------------------------------
    // Fábrica
    // ------------------------------------------------------------------

    /// @notice Recebe a parte desta campanha em uma redistribuição.
    /// @dev A fábrica deve enviar no máximo getRemainingToFund(). Se enviar
    ///      mais (por um bug), a chamada reverte e a redistribuição inteira
    ///      é desfeita.
    function receiveRedistribution() external payable onlyFactory whenActive {
        require(msg.value > 0, ZeroAmount());
        uint256 remaining = getRemainingToFund();
        require(msg.value <= remaining, RedistributionExceedsRemainingGoal(remaining, msg.value));

        campaignBalance += msg.value;
        emit RedistributionReceived(msg.value);
        _checkFullyFunded();
    }

    /// @notice Encerra a campanha e envia o caixa geral para a fábrica.
    /// @dev O admin da campanha encerra pela fábrica (factory.closeCampaign),
    ///      que confere se quem chamou é o admin, chama esta função,
    ///      atualiza os contadores de limite e redistribui o valor.
    ///      Os caixas das instituições continuam disponíveis para saque.
    function close() external onlyFactory whenActive returns (uint256) {
        isActive = false;
        uint256 amount = campaignBalance;
        campaignBalance = 0;
        emit CampaignClosed(amount);

        if (amount > 0) {
            (bool ok, ) = payable(factory).call{value: amount}("");
            require(ok, TransferFailed(factory, amount));
        }

        return amount;
    }

    // ------------------------------------------------------------------
    // Consultas
    // ------------------------------------------------------------------

    /// @notice Quanto ainda pode ser doado ao caixa geral.
    function getRemainingToFund() public view returns (uint256) {
        uint256 covered = totalAllocated + campaignBalance;
        // por construção covered nunca passa da meta; a checagem só evita underflow
        return covered >= campaignGoal ? 0 : campaignGoal - covered;
    }

    function getParticipants() external view returns (address[] memory) {
        return participants;
    }

    function getWithdrawalsCount() external view returns (uint256) {
        return withdrawals.length;
    }

    function getWithdrawal(uint256 withdrawalId) external view returns (Withdrawal memory) {
        require(withdrawalId < withdrawals.length, InvalidWithdrawalId(withdrawalId));
        return withdrawals[withdrawalId];
    }

    // ------------------------------------------------------------------
    // Internas
    // ------------------------------------------------------------------

    /// @dev Emite CampaignFullyFunded uma única vez. Alocar não muda a soma
    ///      (caixa geral + total alocado), então a campanha não "desfinancia".
    function _checkFullyFunded() internal {
        if (!isFullyFunded && getRemainingToFund() == 0) {
            isFullyFunded = true;
            emit CampaignFullyFunded(campaignGoal);
        }
    }
}
