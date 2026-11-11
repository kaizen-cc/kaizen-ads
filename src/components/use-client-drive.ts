"use client";

import { useEffect, useState } from "react";
import type { ClientDrive } from "@/lib/brief-cards";
import { clientDriveLinks } from "@/lib/client-drive-action";

/** The client's Drive headquarters and Ad Creatives folder links for a brief on screen (none for a demo or no client) */
export function useClientDrive(clientId: string | null | undefined) {
  const [drive, setDrive] = useState<{ id: string; links: ClientDrive | null } | null>(null);
  useEffect(() => {
    if (!clientId) return;
    let live = true;
    clientDriveLinks(clientId)
      .then((links) => live && setDrive({ id: clientId, links }))
      .catch(() => live && setDrive({ id: clientId, links: null }));
    return () => {
      live = false;
    };
  }, [clientId]);
  return clientId && drive?.id === clientId ? drive.links : null;
}
