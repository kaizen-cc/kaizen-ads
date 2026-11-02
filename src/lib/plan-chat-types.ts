// One turn of the client's portal conversation, shared by the server and the conversation sheet

export type PlanTurn = { role: "client" | "ai"; text: string; at: string; by?: string; voice?: boolean; files?: string[]; saved?: string[] };
