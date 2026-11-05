import { Schema } from "effect";

export const StoreHandoffBody = Schema.Struct({
  sealed: Schema.String,
});

export type StoreHandoffBodyType = typeof StoreHandoffBody.Type;

export const PutHandoffBody = Schema.Struct({
  sealed: Schema.String,
  writeToken: Schema.String,
});

export type PutHandoffBodyType = typeof PutHandoffBody.Type;

export const assertPodaj1Sealed = (sealed: string): boolean =>
  sealed.startsWith("PODAJ1.");
