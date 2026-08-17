import type { Receipt } from "./domain";
import { ApiError } from "./errors";
import type { ApiRepository } from "./repository";
import { transitionDeliveryState } from "./delivery-service";

function isSameReceiptParticipants(
  receipt: Pick<Receipt, "recipient" | "sender">,
  input: Pick<Receipt, "recipient" | "sender">,
) {
  return receipt.recipient === input.recipient && receipt.sender === input.sender;
}

export async function createDeliveryReceipt(
  repository: ApiRepository,
  input: Pick<Receipt, "messageId" | "recipient" | "sender">,
  now = new Date(),
) {
  const { receipt } = await repository.createReceiptIfAbsent({
    ...input,
    deliveredAt: now.toISOString(),
    readAt: null,
  });

  if (!isSameReceiptParticipants(receipt, input)) {
    throw new ApiError(
      409,
      "conflict",
      "A delivery receipt already exists for this message with different participants",
    );
  }

  try {
    let currentStatus = await repository.getMessageDeliveryStatus(input.messageId);
    if (!currentStatus) {
      await transitionDeliveryState(
        repository,
        input.messageId,
        "accepted",
        input.sender,
        "Envelope accepted by relay",
        null,
        now,
      );
    }
    currentStatus = await repository.getMessageDeliveryStatus(input.messageId);
    if (currentStatus && currentStatus.state !== "delivered" && !currentStatus.isTerminal) {
      await transitionDeliveryState(
        repository,
        input.messageId,
        "delivered",
        input.recipient,
        "Delivered to recipient mailbox",
        null,
        now,
      );
    }
  } catch {
    // Delivery state transition is best-effort when creating receipt
  }

  return receipt;
}

export async function getReceipt(repository: ApiRepository, messageId: string) {
  const receipt = await repository.getReceipt(messageId);
  if (!receipt) {
    throw new ApiError(404, "not_found", "Receipt was not found");
  }
  return receipt;
}

export function assertReceiptParticipant(receipt: Receipt, actor: string) {
  if (actor !== receipt.sender && actor !== receipt.recipient) {
    throw new ApiError(403, "forbidden", "Only message participants can read this receipt");
  }
}

export async function markReceiptRead(
  repository: ApiRepository,
  messageId: string,
  actor: string,
  now = new Date(),
) {
  const result = await repository.markReceiptRead(messageId, actor, now);

  if (result.outcome === "not-found") {
    throw new ApiError(404, "not_found", "Receipt was not found");
  }
  if (result.outcome === "forbidden") {
    throw new ApiError(403, "forbidden", "Only message participants can read this receipt");
  }
  if (result.outcome === "already-read") {
    const receipt = await repository.getReceipt(messageId);
    if (!receipt) {
      throw new ApiError(404, "not_found", "Receipt was not found");
    }
    return receipt;
  }

  try {
    const currentStatus = await repository.getMessageDeliveryStatus(messageId);
    if (!currentStatus) {
      await transitionDeliveryState(
        repository,
        messageId,
        "accepted",
        result.receipt.sender,
        "Envelope accepted",
        null,
        now,
      );
      await transitionDeliveryState(
        repository,
        messageId,
        "delivered",
        result.receipt.recipient,
        "Delivered to recipient mailbox",
        null,
        now,
      );
    }
    const updatedStatus = await repository.getMessageDeliveryStatus(messageId);
    if (updatedStatus && updatedStatus.state === "delivered") {
      await transitionDeliveryState(
        repository,
        messageId,
        "read",
        result.receipt.recipient,
        "Marked as read by recipient",
        null,
        now,
      );
    }
  } catch {
    // Delivery state transition best-effort on mark receipt read
  }

  return result.receipt;
}
