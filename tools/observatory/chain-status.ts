/**
 * On-chain status for the automaton's wallet.
 *
 * Read-only. Reports the wallet address, native balance, USDC balance, and
 * whether the ERC-8004 registry is actually deployed on the target chain —
 * the last one matters because CONTRACTS.testnet in src/registry/erc8004.ts
 * points at the mainnet addresses, which do not exist on Base Sepolia.
 *
 *   npx tsx tools/observatory/chain-status.ts [base-sepolia|base]
 */

import { createPublicClient, http, formatEther, formatUnits, parseAbi } from "viem";
import { base, baseSepolia } from "viem/chains";
import path from "path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.resolve(HERE, "../../src");

const NETWORKS = {
  "base-sepolia": {
    chain: baseSepolia,
    rpc: process.env.RPC_URL || "https://sepolia.base.org",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const,
    faucets: [
      "https://portal.cdp.coinbase.com/products/faucet  (Coinbase Developer Platform)",
      "https://www.alchemy.com/faucets/base-sepolia     (Alchemy)",
      "https://faucet.quicknode.com/base/sepolia        (QuickNode)",
    ],
  },
  base: {
    chain: base,
    rpc: process.env.RPC_URL || "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
    faucets: [],
  },
} as const;

const REGISTRY = {
  identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const,
  reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const,
};

const key = (process.argv[2] || "base-sepolia") as keyof typeof NETWORKS;
const net = NETWORKS[key];
if (!net) {
  console.error(`unknown network "${key}" — use base-sepolia or base`);
  process.exit(1);
}

const { getWallet } = await import(`${SRC}/identity/wallet.js`);
const { chainIdentity } = await getWallet();
const address = chainIdentity.address as `0x${string}`;

const client = createPublicClient({ chain: net.chain, transport: http(net.rpc) });

const [balance, blockNumber] = await Promise.all([
  client.getBalance({ address }),
  client.getBlockNumber(),
]);

let usdc = "unavailable";
try {
  const raw = await client.readContract({
    address: net.usdc,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [address],
  });
  usdc = `${formatUnits(raw as bigint, 6)} USDC`;
} catch {
  /* token contract unreachable on this chain */
}

const [identityCode, reputationCode] = await Promise.all([
  client.getBytecode({ address: REGISTRY.identity }),
  client.getBytecode({ address: REGISTRY.reputation }),
]);
const deployed = (c?: string) => (c && c !== "0x" ? "deployed" : "NOT DEPLOYED");

const line = "─".repeat(66);
console.log(line);
console.log(`  ${net.chain.name}  (chain ${net.chain.id})`);
console.log(line);
console.log(`  wallet     ${address}`);
console.log(`  balance    ${formatEther(balance)} ETH`);
console.log(`  usdc       ${usdc}`);
console.log(`  rpc        ${net.rpc}`);
console.log(`  block      ${blockNumber}`);
console.log(line);
console.log(`  ERC-8004 identity     ${deployed(identityCode)}  ${REGISTRY.identity}`);
console.log(`  ERC-8004 reputation   ${deployed(reputationCode)}  ${REGISTRY.reputation}`);
console.log(line);

if (!identityCode || identityCode === "0x") {
  console.log(
    `\n  Registration is unavailable on ${net.chain.name}: the registry addresses\n` +
      `  in CONTRACTS.testnet are copied from mainnet and hold no code here.\n` +
      `  preflight() now refuses to send rather than burning gas on a no-op.\n` +
      `  Transfers, USDC, and x402 still work on this chain.`,
  );
}

if (balance === 0n && net.faucets.length > 0) {
  console.log(`\n  Wallet is empty. Fund ${address} from a faucet:`);
  for (const f of net.faucets) console.log(`    ${f}`);
}
