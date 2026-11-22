# DApp de rastreamento de doações — regras de negócio

## 1. Visão geral

A DApp é uma plataforma de rastreamento de doações para organizações sociais (instituições de caridade), com o objetivo de aumentar a transparência sobre a utilização dos recursos recebidos. Doações, alocações, saques e comprovantes ficam registrados na blockchain, permitindo que os doadores acompanhem o histórico das transações, os valores utilizados, as descrições dos gastos e os comprovantes disponibilizados pelas instituições.

A solução é composta por dois tipos de contrato:

- **Fábrica (Contract Factory):** contrato principal, único, que cadastra participantes, cria as campanhas e faz a gestão dos dados gerais.
- **Campanha:** um contrato por campanha de arrecadação, criado pela fábrica, responsável por receber as doações, armazenar os recursos e controlar sua movimentação.

## 2. Papéis

2.1. **Administrador da fábrica:** verifica instituições e configura os parâmetros gerais (limites).

2.2. **Administrador de campanha:** propõe a campanha, faz as alocações do caixa geral para as instituições e declara o encerramento da campanha.

2.3. **Instituição de caridade:** participa de campanhas, saca os recursos do seu caixa e registra comprovantes.

2.4. **Doador:** qualquer endereço; deposita recursos e acompanha as movimentações.

## 3. Cadastro e verificação de instituições (fábrica)

3.1. Qualquer instituição pode solicitar seu cadastro na fábrica informando sua carteira, seu CNPJ e um CID (IPFS) dos documentos que comprovam sua existência. Ver [o que é um CID](https://docs.ipfs.tech/concepts/content-addressing/#what-is-a-cid).

3.2. Somente o administrador da fábrica pode verificar uma instituição, após conferir os documentos fora da blockchain.

3.3. Somente instituições verificadas podem participar de campanhas.

3.4. O administrador da fábrica pode revogar a verificação de uma instituição, informando o motivo. Uma instituição revogada não pode entrar em novas campanhas.

> Remover por enquanto e colocar como limitações reconhecidas.

3.5. Administradores de campanha também devem estar cadastrados na fábrica.

> Remover, quem solicita a campanha é o admin, vamos simplificar assim.

3.6. O papel do administrador da fábrica se limita a validar identidades e a gerir parâmetros: ele não aloca nem movimenta recursos das campanhas.

## 4. Criação de campanhas (fábrica)

4.1. O candidato a administrador propõe uma campanha à fábrica, informando:

- a lista de endereços das instituições participantes;
- a meta de arrecadação de cada instituição.

O prazo para as aprovações é fixo: 30 dias, contados a partir da proposta.

4.2. Cada instituição listada deve aprovar a proposta. Qualquer instituição pode recusá-la explicitamente.

4.3. A proposta é cancelada se for recusada por alguma instituição ou se o prazo expirar sem todas as aprovações.

4.4. Quando todas as instituições aprovam, a fábrica verifica as regras de limite (seção 5) e, se forem atendidas, cria (faz o deploy) o contrato da campanha. O candidato passa a ser o administrador da campanha.

4.5. A instituição só passa a contar como participante após aprovar a proposta. Ninguém pode ser incluído em uma campanha sem consentimento.

## 5. Limites de participação (fábrica)

5.1. Um administrador não pode administrar mais de N campanhas ativas ao mesmo tempo (valor inicial: 2).

5.2. Uma instituição não pode participar de mais de M campanhas ativas ao mesmo tempo (valor inicial: 2).

5.3. A fábrica não pode ter mais de K campanhas ativas ao mesmo tempo (valor inicial: 20). Esse limite mantém o custo de gas da redistribuição (seção 11), que percorre as campanhas ativas, sempre dentro do limite de uma transação.

5.3.1. N, M e K são parâmetros configuráveis pelo administrador da fábrica.

5.4. Os limites contam apenas campanhas ativas. O encerramento de uma campanha passa pela fábrica (regra 11.1), que decrementa os contadores do administrador e das instituições.

5.5. Os limites são verificados no momento da criação da campanha (e não no momento da proposta).

5.6. Somente a fábrica que criou a campanha pode encerrá-la e enviar redistribuições a ela.

## 6. Caixas e doações (campanha)

6.1. Cada campanha possui um caixa geral e um caixa individual para cada instituição participante. As doações entram apenas pelo caixa geral; o caixa de cada instituição só recebe recursos por alocação do administrador (seção 7).

6.2. Qualquer endereço pode doar para o caixa geral da campanha, até o valor que ainda falta para cobrir as metas de todas as instituições:

```text
falta = meta da campanha - total já alocado - saldo do caixa geral
```

A meta da campanha é a soma das metas das instituições. Uma doação acima desse valor é recusada por inteiro.

6.3. Não há doação direta a uma instituição pela campanha. Quem doa para a campanha confia ao administrador a distribuição entre as instituições; quem quiser apoiar uma instituição específica doa a ela por fora.

6.4. Uma campanha encerrada não aceita novas doações.

6.5. Quando o caixa geral cobre tudo o que falta, a campanha é considerada totalmente financiada e emite um evento. A partir daí, novas doações são recusadas.

6.6. A redistribuição vinda da fábrica (seção 11) também respeita esse limite: cada campanha recebe no máximo o que ainda lhe falta. A própria campanha recusa (revert) um valor acima disso, o que desfaz a redistribuição inteira.

6.7. Antes de confirmar uma doação ao caixa geral, a interface informa ao doador que, se a campanha for encerrada com saldo no caixa geral, esse saldo não é devolvido: ele é redistribuído a outras campanhas ativas, começando pela mais antiga. O doador precisa marcar que está ciente para prosseguir.

## 7. Alocação (campanha)

7.1. Somente o administrador da campanha pode alocar recursos do caixa geral para o caixa de uma instituição.

7.2. O valor alocado não pode exceder o saldo do caixa geral.

7.3. O total alocado a uma instituição não pode ultrapassar a meta dela.

7.4. Não há alocações após o encerramento da campanha.

## 8. Saques e comprovantes (campanha)

8.1. Somente a própria instituição pode sacar recursos do seu caixa, e o valor é enviado para a carteira cadastrada dela.

8.2. O saque não é pensado como “tirar todo o saldo de uma vez”. A instituição saca a porção correspondente a um gasto específico (ou a um conjunto de gastos cobertos pelo mesmo comprovante), para depois anexar o recibo daquele saque. Cada saque admite um único comprovante; gastos distintos devem gerar saques distintos.

8.3. Todo saque deve informar uma descrição do gasto e recebe um identificador (`saqueId`).

8.4. A instituição vincula o comprovante ao saque posteriormente (por exemplo, após receber a nota fiscal), informando o `saqueId` e o CID/hash do arquivo do comprovante.

8.5. O arquivo do comprovante fica fora da blockchain (IPFS); o contrato armazena apenas seu CID/hash. Qualquer pessoa pode baixar o arquivo, recalcular o hash e confirmar que ele não foi alterado.

8.6. A interface destaca saques que ainda não possuem comprovante.

8.7. Limitação: o sistema garante a integridade, a autoria e a data do comprovante, mas não a sua veracidade, que depende de auditoria humana.

8.8. Os saques seguem o padrão checks-effects-interactions (o saldo é atualizado antes da transferência) para evitar ataques de reentrância.

## 9. Recursos não utilizados pela instituição

9.1. Não existe função de devolução ao caixa geral. Uma instituição que queira abrir mão de recursos pode sacá-los (com descrição) e doá-los, como qualquer doador, ao caixa geral desta ou de outra campanha. As duas operações ficam registradas nos eventos `Saque` e `DoacaoRecebida`.

## 10. Administrador da campanha

10.1. O administrador é quem propôs a campanha e fica definido na criação. Não há troca de administrador.

## 11. Encerramento e redistribuição

11.1. O administrador da campanha declara o encerramento por meio da fábrica, que confere se ele é o administrador e chama o encerramento no contrato da campanha.

11.2. Os saldos já alocados e não sacados continuam pertencendo às respectivas instituições, que ainda podem sacá-los e registrar comprovantes.

11.3. O saldo do caixa geral é transferido para a fábrica, que o redistribui entre as campanhas ainda ativas, por ordem de criação: da mais antiga para a mais nova. A ideia é priorizar campanhas que estão há mais tempo sem atingir a meta.

11.4. Cada campanha recebe no máximo o que ainda lhe falta para cobrir as metas (regra 6.2). Campanhas já totalmente financiadas são puladas, e o restante segue para a próxima da fila.

11.5. A redistribuição termina quando o valor acaba. Se todas as campanhas ativas estiverem cobertas, a sobra fica em um fundo de reserva da fábrica.

11.6. Sempre que uma nova campanha é criada, a fábrica distribui o fundo de reserva pela mesma regra. Qualquer pessoa também pode acionar essa distribuição a qualquer momento.

11.7. Ao encerrar, a fábrica atualiza os contadores de limite (regra 5.4).

## 12. Consultas da fábrica às campanhas

A fábrica interage com os contratos criados, realizando chamadas para consultar, entre outras informações:

- saldo do caixa geral e saldo de cada instituição;
- administrador da campanha e instituições responsáveis;
- metas e situação (ativa/encerrada).

## 13. Eventos

A interface da DApp escuta esses eventos para atualizar automaticamente o histórico de transações, os saldos e as informações exibidas aos doadores.

### Fábrica

- `InstituicaoCadastrada(instituicao, cnpj, cidDocumentos)`
- `InstituicaoVerificada(instituicao, cnpj, cidDocumentos)`
- `VerificacaoRevogada(instituicao, motivo)`
- `PropostaCriada(propostaId, admin, instituicoes, metas, prazo)`
- `PropostaAprovada(propostaId, instituicao)`
- `PropostaRecusada(propostaId, instituicao)`
- `CampanhaCriada(campanha, admin, instituicoes)`
- `LimitesAlterados(limiteAdmin, limiteInstituicao, limiteCampanhasAtivas)`
- `Redistribuicao(campanhaOrigem, valorTotal)`
- `RedistribuicaoEnviada(campanhaDestino, valor)`
- `ReservaAtualizada(saldoReserva)`

### Campanha

- `DoacaoRecebida(doador, valor)`
- `Alocacao(instituicao, valor)`
- `Saque(saqueId, instituicao, valor, descricao)`
- `ComprovanteRegistrado(saqueId, instituicao, cid)`
- `CampanhaTotalmenteFinanciada(metaDaCampanha)`
- `CampanhaEncerrada(campanha, saldoCaixaGeral)`
