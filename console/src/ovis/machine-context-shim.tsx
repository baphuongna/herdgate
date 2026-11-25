import { createContext, useContext, useMemo } from "react";
import { createReadOnlyOvisMachineApi } from "./machine-api-deny.ts";

export interface LayoutOffer { rename: boolean; split: boolean; move: boolean; arrange: boolean; worktrees: boolean }

const NO_LAYOUT: LayoutOffer = Object.freeze({ rename: false, split: false, move: false, arrange: false, worktrees: false });
export const FULL_LAYOUT = NO_LAYOUT;
export const MachineContext = createContext("local");
export const AppLayoutContext = createContext<LayoutOffer>(NO_LAYOUT);
export const ReorderContext = createContext<null>(null);

export const useMachineId = () => useContext(MachineContext);
export const useAppLayout = () => useContext(AppLayoutContext);
export const useReorderCoordinator = () => useContext(ReorderContext);
export const appLayoutOf = (_herdr: unknown): LayoutOffer => NO_LAYOUT;

/** Every Ovis machine read/write route rejects locally; the Console client owns allowed I/O. */
export function useMachineApi() {
  return useMemo(() => createReadOnlyOvisMachineApi(), []);
}
