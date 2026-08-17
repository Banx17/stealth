import type { Receipt } from "./domain";
import { ApiError } from "./errors";
import type { ApiRepository } from "./repository";
import { transitionDeliveryState } from "./delivery-service";

export async function createDeliveryReceipt(
  repository: ApiRepository,
  input: Pick<Receipt, "messageId" | "recipient" | "sender">,
  now = new Date(),
) {
  if (await repository.getReceipt(input.messageId)) {
    throw new ApiError(409, "conflict", "A delivery receipt already exists for this message");
  }

  const receipt = await repository.setReceipt({
    ...input,
    deliveredAt: now.toISOString(),
    readAt: null,
  });

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
  now = new Date(),
) {
  const receipt = await getReceipt(repository, messageId);
  if (receipt.readAt) {
    throw new ApiError(409, "conflict", "The receipt has already been marked as read", {
      readAt: receipt.readAt,
    });
  }

  const updatedReceipt = await repository.setReceipt({
    ...receipt,
    readAt: now.toISOString(),
  });

  try {
    const currentStatus = await repository.getMessageDeliveryStatus(messageId);
    if (!currentStatus) {
      await transitionDeliveryState(
        repository,
        messageId,
        "accepted",
        receipt.sender,
        "Envelope accepted",
        null,
        now,
      );
      await transitionDeliveryState(
        repository,
        messageId,
        "delivered",
        receipt.recipient,
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
        receipt.recipient,
        "Marked as read by recipient",
        null,
        now,
      );
    }
  } catch {
    // Delivery state transition best-effort on mark receipt read
  }

  return updatedReceipt;
}
