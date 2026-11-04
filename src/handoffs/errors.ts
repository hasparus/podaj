import { Schema } from "effect";

export class HandoffsApiError extends Schema.TaggedError<HandoffsApiError>()(
  "HandoffsApiError",
  {
    code: Schema.String,
    status: Schema.Number,
  },
) {}
