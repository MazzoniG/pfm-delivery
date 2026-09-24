export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly type: string;
  abstract readonly title: string;

  /** RFC 9457 extension members, merged into the problem document as-is. */
  readonly extensions: Readonly<Record<string, unknown>> = {};

  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  readonly status = 404;
  readonly type = 'https://pfm.local/problems/not-found';
  readonly title = 'Resource not found';
}

export class ValidationError extends AppError {
  readonly status = 400;
  readonly type = 'https://pfm.local/problems/validation';
  readonly title = 'Request validation failed';

  constructor(
    message: string,
    readonly issues: ReadonlyArray<{ path: string; message: string }>,
  ) {
    // `errors` is for code; `detail` is the sentence a client renders as written.
    super(
      message,
      issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '),
    );
  }
}

export class ConflictError extends AppError {
  readonly status = 409;
  readonly type = 'https://pfm.local/problems/conflict';
  readonly title = 'Conflict';
}

/**
 * The 409 a reconciled entry answers with. It carries `lockedAt` because the
 * dialog that renders it says *when* the entry was reconciled, and the link to
 * the correction endpoint because refusing an edit without saying what to do
 * instead is how a 409 becomes a dead end.
 */
export class EntryLockedError extends AppError {
  readonly status = 409;
  readonly type = 'https://pfm.local/problems/entry-locked';
  readonly title = 'Entry is reconciled';
  override readonly extensions: { lockedAt: string; correction: string };

  constructor(lockedAt: Date, correctionPath: string) {
    super(
      'Entry is reconciled',
      `This entry was reconciled on ${lockedAt.toISOString()} and can only be changed by posting a correction.`,
    );
    this.extensions = {
      lockedAt: lockedAt.toISOString(),
      correction: correctionPath,
    };
  }
}

export class EntryAlreadyCorrectedError extends AppError {
  readonly status = 409;
  readonly type = 'https://pfm.local/problems/entry-already-corrected';
  readonly title = 'Entry is already corrected';
  override readonly extensions: { reversedByEntryId: string; reversal: string };

  constructor(entryId: string, reversedByEntryId: string, reversalPath: string) {
    super(
      'Entry is already corrected',
      `Entry ${entryId} was already corrected by reversal ${reversedByEntryId}. Correct its replacement instead.`,
    );
    this.extensions = { reversedByEntryId, reversal: reversalPath };
  }
}

export class MalformedJsonError extends AppError {
  readonly status = 400;
  readonly type = 'https://pfm.local/problems/malformed-json';
  readonly title = 'Malformed JSON';
}

export class PayloadTooLargeError extends AppError {
  readonly status = 413;
  readonly type = 'https://pfm.local/problems/payload-too-large';
  readonly title = 'Payload too large';
}

/**
 * Paying a bill that is already paid. It names the entry that paid it, so the
 * client can open that transaction rather than posting a second one — a
 * double payment is the failure `materialized_entry_id` exists to prevent, and
 * a bare 409 would leave the user unable to tell a duplicate from a mistake.
 */
export class OccurrencePaidError extends AppError {
  readonly status = 409;
  readonly type = 'https://pfm.local/problems/occurrence-paid';
  readonly title = 'Bill is already paid';
  override readonly extensions: { materializedEntryId: string };

  constructor(materializedEntryId: string) {
    super(
      'Bill is already paid',
      `This bill was already paid by entry ${materializedEntryId}.`,
    );
    this.extensions = { materializedEntryId };
  }
}

export class UnprocessableError extends AppError {
  readonly status = 422;
  readonly type = 'https://pfm.local/problems/unprocessable';
  readonly title = 'Request cannot be processed';
}

/**
 * Deleting a project that lines still reference. The count is in `detail`
 * for the dialog to render as written, and as a member for code to read.
 */
export class ProjectInUseError extends AppError {
  readonly status = 409;
  readonly type = 'https://pfm.local/problems/project-in-use';
  readonly title = 'Project is in use';
  override readonly extensions: { transactionCount: number };

  constructor(name: string, transactionCount: number) {
    super(
      'Project is in use',
      `${transactionCount} ${transactionCount === 1 ? 'transaction is' : 'transactions are'} assigned to ${name}. Remove it from them first.`,
    );
    this.extensions = { transactionCount };
  }
}
