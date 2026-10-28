// Each agent's color (by its icon), shared by the agents page and the Expenses breakdown so an agent looks the same
// everywhere.
export const AGENT_TINT: Record<string, string> = { compass: "#5b8def", shield: "#b21e2c", feed: "#2fa37a", pen: "#c08a2e", rocket: "#8a63d2", pulse: "#d1495b", film: "#e07a3f", book: "#3fa7b5", eye: "#6c7ee1", scan: "#9b6bd6", target: "#e0a03f", spark: "#888888" };
export const tintOf = (icon: string | null | undefined) => AGENT_TINT[icon ?? ""] ?? AGENT_TINT.spark;
