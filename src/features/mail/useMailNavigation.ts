import { useCallback, useEffect, useMemo, useState } from "react";

import {
  defaultMailFilters,
  type Email,
  type MailFilters,
  type MailFolder,
} from "@/components/mail/data";
import {
  buildFolderCounts,
  firstCustomFolderMatch,
  nextSelectedId,
  visibleEmailsFor,
} from "./navigation";

export function useMailNavigation(emails: Email[]) {
  const [folder, setFolder] = useState<MailFolder>("inbox");
  const [customFolder, setCustomFolder] = useState<string | null>(null);
  const [filters, setFilters] = useState<MailFilters>(defaultMailFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const folderCounts = useMemo(() => buildFolderCounts(emails), [emails]);
  const visibleEmails = useMemo(
    () => visibleEmailsFor(emails, folder, customFolder),
    [customFolder, emails, folder],
  );
  const selectedEmails = useMemo(
    () => visibleEmails.filter((email) => selectedIds.includes(email.id)),
    [selectedIds, visibleEmails],
  );
  const selected = emails.find((email) => email.id === selectedId) ?? null;

  const selectFolder = useCallback((next: MailFolder) => {
    setFolder(next);
    setCustomFolder(null);
  }, []);

  const openMessage = useCallback((email: Email) => {
    setCustomFolder(null);
    setFilters(defaultMailFilters);
    setFolder(email.folder);
    setSelectedId(email.id);
    setSelectedIds([]);
  }, []);

  useEffect(() => {
    if (customFolder) return;
    setSelectedId((current) => nextSelectedId(visibleEmails, current));
  }, [customFolder, folder, visibleEmails]);

  useEffect(() => {
    if (!customFolder) return;
    setSelectedId(firstCustomFolderMatch(emails, customFolder));
  }, [customFolder, emails]);

  return {
    folder,
    setFolder,
    customFolder,
    setCustomFolder,
    filters,
    setFilters,
    selectedId,
    setSelectedId,
    selectedIds,
    setSelectedIds,
    folderCounts,
    visibleEmails,
    selectedEmails,
    selected,
    selectFolder,
    openMessage,
  };
}
