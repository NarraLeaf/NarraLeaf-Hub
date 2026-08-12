/**
 * Reading a password without writing it on a command line.
 *
 * An argument is visible to every process on the machine through the process
 * list, and it stays in the shell's history afterwards. A password therefore
 * arrives on standard input:
 *
 *     nlhub user create ada --root /srv/hub --invite CODE < password.txt
 *     printf '%s' "$PASSWORD" | nlhub token mint ada --root /srv/hub
 */

/** Raised when nothing was piped in and there is nothing to read. */
export class NoPasswordError extends Error {
  constructor() {
    super(
      "this command reads the password from standard input, and standard input is the " +
        "terminal. Pipe it in or redirect a file into the command; passing it as an " +
        "argument would put it in the process list and in your shell history.",
    );
    this.name = "NoPasswordError";
  }
}

/**
 * Read a password from standard input.
 *
 * One trailing line ending is removed, because `echo` adds one and nobody
 * means it as part of their password. Nothing else is trimmed: a space at
 * either end is a character somebody chose.
 */
export async function readPassword(): Promise<string> {
  if (process.stdin.isTTY === true) {
    throw new NoPasswordError();
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}
