// BETA-051 (Issue #1958) — typed web data-access hooks for the mail feature.
// Components import these (or the `@/lib/api` clients directly) instead of
// calling `fetch`. Demo fixtures are isolated behind `src/features/mail/demo`
// so the production app shell never reaches them.

export { useSession, useLogout, sessionActor } from "./useSession";
export {
  useMailbox,
  useTombstoneMessage,
  mailboxDescriptorToEmail,
  mailboxQueueToEmails,
} from "./useMailbox";
export type { UseMailboxOptions } from "./useMailbox";
export { useRequests, useSenderRequestDecision } from "./useRequests";
export { useContacts, useCreateContact } from "./useContacts";
export { useMailboxPolicy, useUpdateMailboxPolicy } from "./usePolicy";
export { useMailboxSettings, useUpdateMailboxSettings } from "./useSettings";
export type { MailboxSettings } from "./useSettings";
