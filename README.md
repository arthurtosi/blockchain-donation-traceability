# Rastreamento de doações na blockchain

Plataforma on-chain para campanhas de arrecadação de organizações sociais. Doações, alocações, saques e comprovantes ficam registrados na blockchain, permitindo acompanhar o uso dos recursos com transparência.

As regras de negócio estão detalhadas em [`ESPECIFICACAO.md`](./ESPECIFICACAO.md).

## Arquitetura

Dois contratos Solidity (`^0.8.34`):

| Contrato | Papel |
|---|---|
| `CampaignFactory` | Contrato principal. Cadastro e verificação de instituições, propostas de campanha, limites de participação, deploy das campanhas, encerramento e redistribuição do caixa geral. |
| `FundraisingCampaign` | Um contrato por campanha. Caixa geral, caixas das instituições, doações, alocações, saques e comprovantes (CID/IPFS). |

Fluxo resumido:

1. Instituições se cadastram e são verificadas pelo admin da fábrica.
2. Um administrador propõe uma campanha (instituições + metas). Cada instituição aprova ou recusa (prazo de 30 dias).
3. Com todas as aprovações e dentro dos limites, a fábrica faz o deploy da campanha.
4. Doadores depositam no caixa geral; o admin aloca para as instituições; cada instituição saca e registra comprovantes.
5. No encerramento, o saldo restante do caixa geral vai para a fábrica e é redistribuído às campanhas ativas mais antigas (ou fica em reserva).

## Estrutura do repositório

```text
contracts/          Contratos Solidity
test/               Testes de integração TypeScript (node:test + viem)
ignition/modules/   Módulo Hardhat Ignition (deploy da fábrica)
ESPECIFICACAO.md    Regras de negócio
```

Stack: [Hardhat 3](https://hardhat.org/), [`@nomicfoundation/hardhat-toolbox-viem`](https://hardhat.org/docs) e [viem](https://viem.sh/).

## Pré-requisitos

- Node.js 22+
- Dependências: `npm install`

## Testes

```shell
npx hardhat test
```

## Deploy

O Ignition implanta apenas a fábrica. As campanhas são criadas depois pela própria fábrica, quando as instituições aprovam uma proposta.

### Rede local simulada

#### Rede efêmera (só para aquele comando)

Sem `--network`, o Hardhat sobe uma rede em memória, faz o deploy e encerra. O estado some ao terminar o comando:

```shell
npx hardhat ignition deploy ignition/modules/CampaignFactory.ts
```

#### Node local persistente

Em um terminal, sobe o node (fica rodando e mantém o estado):

```shell
npx hardhat node
```

Em outro terminal, faz o deploy apontando para esse node:

```shell
npx hardhat ignition deploy --network localhost ignition/modules/CampaignFactory.ts
```

### Sepolia

Configure as variáveis e rode o deploy:

```shell
npx hardhat keystore set SEPOLIA_RPC_URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY

npx hardhat ignition deploy --network sepolia ignition/modules/CampaignFactory.ts
```

O deployer da fábrica se torna o `owner` (administrador da fábrica).
