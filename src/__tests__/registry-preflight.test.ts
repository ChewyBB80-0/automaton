/**
 * ERC-8004 preflight tests.
 *
 * The registry contracts (0x8004A169… / 0x8004BAa1…) are deployed on Base
 * mainnet but NOT on Base Sepolia, while CONTRACTS.testnet points at the same
 * addresses. Sending calldata to an address with no code does not revert — the
 * EVM treats it as a plain transfer — so estimateGas succeeds at ~23k, the
 * transaction confirms with status "success", and the receipt has no logs.
 * Registration therefore appeared to work while registering nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getBytecode = vi.fn();
const estimateGas = vi.fn();
const getGasPrice = vi.fn();
const getBalance = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getBytecode,
      estimateGas,
      getGasPrice,
      getBalance,
      waitForTransactionReceipt: vi.fn(),
    }),
    createWalletClient: () => ({ writeContract: vi.fn() }),
  };
});

describe("ERC-8004 preflight contract check", () => {
  beforeEach(() => {
    vi.resetModules();
    getBytecode.mockReset();
    estimateGas.mockReset().mockResolvedValue(23_416n);
    getGasPrice.mockReset().mockResolvedValue(1_000_000n);
    getBalance.mockReset().mockResolvedValue(10n ** 18n);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function attemptRegister() {
    const { registerAgent } = await import("../registry/erc8004.js");
    const account = {
      address: "0xe09044735703a75321877DF1ec763C5A9c775975",
    } as any;
    const db = { setRegistryEntry: vi.fn(), raw: {} } as any;
    return registerAgent(
      account,
      "https://example.com/agent.json",
      "testnet",
      db,
    );
  }

  it("refuses to send when the registry has no code on that chain", async () => {
    getBytecode.mockResolvedValue(undefined);

    await expect(attemptRegister()).rejects.toThrow(/No contract deployed/);
    // The critical assertion: nothing was broadcast.
    expect(estimateGas).not.toHaveBeenCalled();
  });

  it("treats '0x' the same as absent bytecode", async () => {
    getBytecode.mockResolvedValue("0x");

    await expect(attemptRegister()).rejects.toThrow(/No contract deployed/);
    expect(estimateGas).not.toHaveBeenCalled();
  });

  it("names the function it refused to send", async () => {
    getBytecode.mockResolvedValue("0x");

    await expect(attemptRegister()).rejects.toThrow(/register/);
  });

  it("proceeds past the check when the contract is deployed", async () => {
    getBytecode.mockResolvedValue("0x60806040");

    // Past the guard the call fails later (the wallet client is a stub), but it
    // must not fail with the deployment error.
    await expect(attemptRegister()).rejects.not.toThrow(/No contract deployed/);
    expect(estimateGas).toHaveBeenCalled();
  });
});
