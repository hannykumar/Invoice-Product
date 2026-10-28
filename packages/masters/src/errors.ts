import type { MatchCandidate, MatchableRecord } from "./matching.ts";
import type { ValidationProblem } from "./validation.ts";

export class MasterDataError extends Error {
  public readonly code: "VALIDATION_FAILED" | "DUPLICATE_BLOCKED" | "NOT_FOUND" | "CONFLICT";
  public readonly problems: readonly ValidationProblem[];
  public readonly candidates: readonly MatchCandidate<MatchableRecord>[];
  constructor(code: MasterDataError["code"], message: string, problems: readonly ValidationProblem[] = [], candidates: readonly MatchCandidate<MatchableRecord>[] = []) {
    super(message);
    this.code = code;
    this.problems = problems;
    this.candidates = candidates;
  }
}
