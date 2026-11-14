"use client";

import { createContext, useContext } from "react";
import type { OfflineSession } from "../lib/offline-store";

export type OfflineState = {
  offline: boolean;
  session: OfflineSession | null;
  savedAt: number | null;
  onOffline: () => void;
};

const OfflineContext = createContext<OfflineState>({
  offline: false,
  session: null,
  savedAt: null,
  onOffline: () => {},
});

export const OfflineProvider = OfflineContext.Provider;
export const useOffline = () => useContext(OfflineContext);
