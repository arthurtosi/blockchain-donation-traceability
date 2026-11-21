import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Implanta a fábrica. As campanhas são criadas depois, pela própria fábrica,
// quando as instituições aprovam uma proposta.
//
//   local:   npx hardhat ignition deploy ignition/modules/CampaignFactory.ts
//   Sepolia: npx hardhat ignition deploy --network sepolia ignition/modules/CampaignFactory.ts
export default buildModule("CampaignFactoryModule", (m) => {
  const factory = m.contract("CampaignFactory");
  return { factory };
});
