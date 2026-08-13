/**
 * Turning a password into something safe to store, and checking one against it.
 *
 * A stored hash carries its own algorithm and its own parameters:
 *
 *     scrypt$N=131072,r=8,p=1$<salt base64>$<hash base64>
 *
 * Nothing outside this file parses that string. Carrying the parameters means
 * the cost can be raised, or the algorithm replaced, without invalidating what
 * is already stored: an old hash still verifies under the parameters it was
 * made with, and {@link PasswordHasher.needsRehash} tells the caller it is
 * worth replacing. The replacement happens on the next successful sign-in,
 * where the plain password is in hand for the only moment it ever is.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/** `crypto.scrypt` as a promise. It has no promisified form of its own. */
function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

/** Raised when a stored hash cannot be understood, and so cannot be checked. */
export class MalformedPasswordHashError extends Error {
  constructor(reason: string) {
    super(
      `a stored password hash could not be read: ${reason}. The account cannot be ` +
        "signed in to until its password is set again.",
    );
    this.name = "MalformedPasswordHashError";
  }
}

/**
 * What a password hasher has to be able to do.
 *
 * Kept to three methods so that a second algorithm is a second class rather
 * than a branch inside this one.
 */
export interface PasswordHasher {
  /** Hash `password` into a string that carries everything needed to check it. */
  hash(password: string): Promise<string>;
  /**
   * Whether `password` is the one `stored` was made from.
   *
   * Raises {@link MalformedPasswordHashError} if `stored` is not a hash this
   * implementation understands. That is deliberately not the same answer as
   * `false`: a damaged record and a wrong password are different problems, and
   * only one of them is the person typing. Callers must still report both to a
   * remote user with the same words — `authenticate` in ./users.ts is where
   * the two are flattened back into one answer.
   */
  verify(password: string, stored: string): Promise<boolean>;
  /** Whether `stored` was made by something other than the current settings. */
  needsRehash(stored: string): boolean;
}

/** The knobs scrypt takes. */
export interface ScryptParameters {
  /** CPU and memory cost. A power of two; the work is proportional to it. */
  readonly cost: number;
  /** Block size. Scales memory use alongside `cost`. */
  readonly blockSize: number;
  /** Parallelisation. */
  readonly parallelism: number;
  /** Length of the derived key, in bytes. */
  readonly keyLength: number;
}

/**
 * OWASP's recommended scrypt settings, as of 2026: N = 2^17, r = 8, p = 1.
 *
 * That is around 128 MiB of memory per hash and a few hundred milliseconds of
 * CPU, which is the point — it is what makes guessing a stolen hash expensive.
 * Raising these numbers later costs nothing: existing hashes keep verifying
 * under the parameters recorded in them, and are replaced as people sign in.
 */
export const OWASP_SCRYPT_PARAMETERS: ScryptParameters = {
  cost: 2 ** 17,
  blockSize: 8,
  parallelism: 1,
  keyLength: 32,
};

/** Bytes of salt. Long enough that no two users share one, ever. */
const SALT_BYTES = 16;

/** The name this implementation writes, and the only one it will read. */
const ALGORITHM = "scrypt";

/**
 * node's scrypt refuses to allocate more than 32 MiB unless told otherwise, and
 * these parameters need 128 * N * r bytes — about 128 MiB. Without a raised
 * `maxmem` it does not run slowly, it throws.
 */
function maximumMemory(parameters: ScryptParameters): number {
  return 128 * parameters.cost * parameters.blockSize * 2;
}

function encodeParameters(parameters: ScryptParameters): string {
  return `N=${parameters.cost},r=${parameters.blockSize},p=${parameters.parallelism}`;
}

/** Decode base64 and insist it was base64, rather than accepting near misses. */
function decodeBase64(text: string, what: string): Buffer {
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== text) {
    throw new MalformedPasswordHashError(`its ${what} is not base64`);
  }
  return bytes;
}

/** A stored hash, taken apart. */
interface ParsedHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

/**
 * Take a stored string apart.
 *
 * Everything that is not exactly the expected shape is an error rather than a
 * best effort: a hash that is half-understood would be checked against the
 * wrong parameters and answer "no match" for the right password.
 */
function parse(stored: string): ParsedHash {
  const fields = stored.split("$");
  if (fields.length !== 4) {
    throw new MalformedPasswordHashError("it is not four $-separated fields");
  }
  const [algorithm, parameterText, saltText, hashText] = fields as [
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== ALGORITHM) {
    throw new MalformedPasswordHashError(`its algorithm "${algorithm}" is not ${ALGORITHM}`);
  }

  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parameterText);
  if (match === null) {
    throw new MalformedPasswordHashError(`its parameters "${parameterText}" are not readable`);
  }
  const cost = Number(match[1]);
  const blockSize = Number(match[2]);
  const parallelism = Number(match[3]);
  // scrypt requires N to be a power of two greater than one; anything else
  // makes the derivation throw rather than answer.
  if (cost < 2 || (cost & (cost - 1)) !== 0 || blockSize < 1 || parallelism < 1) {
    throw new MalformedPasswordHashError(`its parameters "${parameterText}" are out of range`);
  }

  const salt = decodeBase64(saltText, "salt");
  const hash = decodeBase64(hashText, "hash");
  return {
    parameters: { cost, blockSize, parallelism, keyLength: hash.length },
    salt,
    hash,
  };
}

/** Hashing with scrypt, the algorithm Team uses today. */
export class ScryptPasswordHasher implements PasswordHasher {
  readonly #parameters: ScryptParameters;

  constructor(parameters: ScryptParameters = OWASP_SCRYPT_PARAMETERS) {
    this.#parameters = parameters;
  }

  /** The parameters new hashes are made with. */
  get parameters(): ScryptParameters {
    return this.#parameters;
  }

  /**
   * The password is normalised first: the same characters typed on two
   * keyboards can arrive as different byte sequences, and a person whose name
   * or passphrase carries an accent would otherwise be locked out by which
   * machine they set it on.
   */
  async #derive(password: string, salt: Buffer, parameters: ScryptParameters): Promise<Buffer> {
    return await deriveKey(password.normalize("NFKC"), salt, parameters.keyLength, {
      N: parameters.cost,
      r: parameters.blockSize,
      p: parameters.parallelism,
      maxmem: maximumMemory(parameters),
    });
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const derived = await this.#derive(password, salt, this.#parameters);
    return [
      ALGORITHM,
      encodeParameters(this.#parameters),
      salt.toString("base64"),
      derived.toString("base64"),
    ].join("$");
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    const derived = await this.#derive(password, parsed.salt, parsed.parameters);
    // Lengths are compared first because timingSafeEqual throws on a mismatch,
    // and the length of a stored hash is a parameter of the record rather than
    // anything the password decides. The comparison itself takes the same time
    // whether the first byte differs or none of them do, so a caller cannot be
    // told how much of a guess was right.
    if (derived.length !== parsed.hash.length) {
      return false;
    }
    return timingSafeEqual(derived, parsed.hash);
  }

  needsRehash(stored: string): boolean {
    let parsed: ParsedHash;
    try {
      parsed = parse(stored);
    } catch {
      // Something this implementation cannot read is certainly not something
      // it wrote with the current parameters. Saying so is safe: rehashing
      // only ever happens after a successful verify, which such a string
      // cannot produce.
      return true;
    }
    const current = this.#parameters;
    return (
      parsed.parameters.cost !== current.cost ||
      parsed.parameters.blockSize !== current.blockSize ||
      parsed.parameters.parallelism !== current.parallelism ||
      parsed.hash.length !== current.keyLength
    );
  }
}

/** The hasher Team uses when a caller expresses no preference. */
export function defaultPasswordHasher(): PasswordHasher {
  return new ScryptPasswordHasher();
}
