import { ConflictError, UnprocessableError } from '../errors/app-error.js';

type DriverCause = { code?: string; message?: string };

const causeOf = (error: unknown): DriverCause | undefined =>
  (
    error as {
      meta?: { driverAdapterError?: { cause?: DriverCause } };
    }
  )?.meta?.driverAdapterError?.cause;

/**
 * The service checks these rules before writing, so this is the second line:
 * a race, a future code path, or a bug must still produce an answer the client
 * can read rather than a 500. The SQLSTATEs are the ones the ledger baseline
 * migration defines — which is most of why they are custom.
 */
export const translateLedgerError = (error: unknown): unknown => {
  const cause = causeOf(error);
  switch (cause?.code) {
    case 'PFM01':
      return new UnprocessableError('Entry does not balance', cause.message);
    case 'PFM02':
      return new ConflictError('Entry is reconciled', cause.message);
    case '23514':
      return new UnprocessableError('Line is not a posting', cause.message);
    default:
      return error;
  }
};

export const guardLedgerWrite = async <T>(write: () => Promise<T>): Promise<T> => {
  try {
    return await write();
  } catch (error) {
    throw translateLedgerError(error);
  }
};
