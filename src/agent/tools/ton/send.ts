import { Type } from "@sinclair/typebox";
import type { Tool, ToolExecutor, ToolResult } from "../types.js";
import { loadWallet } from "../../../ton/wallet-service.js";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV5R1, TonClient, toNano, internal } from "@ton/ton";
import { Address, SendMode } from "@ton/core";
import { getCachedHttpEndpoint } from "../../../ton/endpoint.js";
interface SendParams {
  to: string;
  amount: number;
  comment?: string;
}
export const tonSendTool: Tool = {
  name: "ton_send",
  description:
    "Send TON cryptocurrency to an address. Requires wallet to be initialized. Amount is in TON (not nanoTON). Example: amount 1.5 = 1.5 TON. Always confirm the transaction details before sending.",
  parameters: Type.Object({
    to: Type.String({
      description: "Recipient TON address (EQ... or UQ... format)",
    }),
    amount: Type.Number({
      description: "Amount to send in TON (e.g., 1.5 for 1.5 TON)",
      minimum: 0.001,
    }),
    comment: Type.Optional(
      Type.String({
        description: "Optional comment/memo for the transaction",
      })
    ),
  }),
};
export const tonSendExecutor: ToolExecutor<SendParams> = async (
  params,
  context
): Promise<ToolResult> => {
  try {
    const { to, amount, comment } = params;

    const walletData = loadWallet();
    if (!walletData) {
      return {
        success: false,
        error: "Wallet not initialized. Contact admin to generate wallet.",
      };
    }

    try {
      Address.parse(to);
    } catch (e) {
      return {
        success: false,
        error: `Invalid recipient address: ${to}`,
      };
    }

    const keyPair = await mnemonicToPrivateKey(walletData.mnemonic);

    const wallet = WalletContractV5R1.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });

    // Get decentralized endpoint from orbs network (no rate limits)
    const endpoint = await getCachedHttpEndpoint();
    const client = new TonClient({ endpoint });

    const contract = client.open(wallet);

    const seqno = await contract.getSeqno();

    await contract.sendTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        internal({
          to: Address.parse(to),
          value: toNano(amount),
          body: comment || "",
          bounce: false,
        }),
      ],
    });

    return {
      success: true,
      data: {
        to,
        amount,
        comment: comment || null,
        from: walletData.address,
        message: `Sent ${amount} TON to ${to}${comment ? ` (${comment})` : ""}`,
      },
    };
  } catch (error) {
    console.error("Error in ton_send:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
