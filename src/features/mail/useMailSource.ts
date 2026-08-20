// ---------------------------------------------------------------------------
// BETA-053 (Issue #1960) — live mailbox source + workspace overlay.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Email } from "@/components/mail/data";
import { errorLabel, normalizeApiClientError } from "@/lib/api";
import { sessionActor, useSession } from "./useSession";
import { useMailbox, useTombstoneMessage } from "./useMailbox";
import { resolveMailSourceView, type MailSourceView } from "./source-view";
import {
  applyEmailPatch,
  EMPTY_MAIL_WORKSPACE,
  insertWorkspaceEmail,
  mergeMailWorkspace,
  revertEmailPatch,
  type MailWorkspaceOverlay,
} from "./workspace";

export interface UseMailSourceOptions {
  isDemoMode: boolean;
}

export type TrashResult = { ok: true } | { ok: false; reason: string };

export function useMailSource({ isDemoMode }: UseMailSourceOptions) {
  const session = useSession({ enabled: !isDemoMode });
  const actor = sessionActor(session.data);
  const mailbox = useMailbox({
    actor: actor ?? "anonymous",
    enabled: Boolean(actor) && !isDemoMode,
  });
  const tombstone = useTombstoneMessage(actor ?? "anonymous");

  const [demoEmails, setDemoEmails] = useState<Email[]>([]);
  const [demoReady, setDemoReady] = useState(!isDemoMode);
  const [overlay, setOverlay] = useState<MailWorkspaceOverlay>(EMPTY_MAIL_WORKSPACE);
  const pendingTrash = useRef(new Set<string>());

  useEffect(() => {
    if (!import.meta.env.DEV || !isDemoMode) return;
    let cancelled = false;
    void import("@/features/mail/demo/demo-data").then(({ getDemoEmails }) => {
      if (cancelled) return;
      setDemoEmails(getDemoEmails());
      setDemoReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isDemoMode]);

  const serverEmails = isDemoMode ? demoEmails : (mailbox.data ?? []);
  const emails = useMemo(() => mergeMailWorkspace(serverEmails, overlay), [overlay, serverEmails]);

  const updateEmail = useCallback((id: string, patch: Partial<Email>) => {
    setOverlay((current) => applyEmailPatch(current, id, patch));
  }, []);

  const insertEmail = useCallback((email: Email) => {
    setOverlay((current) => insertWorkspaceEmail(current, email));
  }, []);

  const trashEmail = useCallback(
    async (email: Email): Promise<TrashResult> => {
      if (email.folder === "trash") return { ok: true };
      if (pendingTrash.current.has(email.id)) {
        return { ok: false, reason: "This message is already being updated" };
      }
      pendingTrash.current.add(email.id);
      setOverlay((current) => applyEmailPatch(current, email.id, { folder: "trash" }));

      if (isDemoMode || !actor) {
        pendingTrash.current.delete(email.id);
        return { ok: true };
      }

      try {
        await tombstone.mutateAsync(email.id);
        pendingTrash.current.delete(email.id);
        return { ok: true };
      } catch (error) {
        pendingTrash.current.delete(email.id);
        setOverlay((current) => revertEmailPatch(current, email.id, { folder: email.folder }));
        return { ok: false, reason: errorLabel(normalizeApiClientError(error)) };
      }
    },
    [actor, isDemoMode, tombstone],
  );

  const retry = useCallback(async () => {
    if (session.isError) await session.refetch();
    if (mailbox.isError) await mailbox.refetch();
  }, [mailbox, session]);

  const online = typeof navigator === "undefined" ? true : navigator.onLine;
  const sourceView: MailSourceView = resolveMailSourceView({
    isDemoMode,
    demoReady,
    sessionLoading: session.isLoading,
    sessionError: session.error,
    mailboxLoading: mailbox.isLoading,
    mailboxFetching: mailbox.isFetching,
    mailboxError: mailbox.error,
    mailboxFetched: mailbox.isFetched,
    emailCount: emails.length,
    online,
  });

  return {
    actor,
    emails,
    updateEmail,
    insertEmail,
    trashEmail,
    retry,
    sourceView,
    isDemoMode,
  };
}
