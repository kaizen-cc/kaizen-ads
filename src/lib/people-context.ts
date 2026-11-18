import { createContext, useContext } from "react";

// Who's on the team, by name, so any avatar can show a person's picture and link to their profile without every screen
// passing it along. Filled once by the team layout; where it isn't (a client portal), avatars stay initials.

export type PersonEntry = { id: string; url: string | null; display: string };

export const peopleKey = (name: string) => name.trim().toLowerCase();

export const PeopleCtx = createContext<ReadonlyMap<string, PersonEntry>>(new Map());

export const usePeople = () => useContext(PeopleCtx);
