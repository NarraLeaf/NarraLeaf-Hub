// What the terminal interface is allowed to know.
//
// Everything the interface draws comes through this one read-only structure,
// gathered once per refresh by the code that owns the database and the
// supervisor. The interface itself opens nothing and writes nothing: it is
// handed a view and it draws it. That is what keeps the terminal interface and
// the commands from drifting into two implementations of the same rules.
//
// Every field that Team server might fail to work out is optional, and an absent field
// is drawn as "unknown" rather than as an error. This is the whole of the
// degradation rule: a project written by a newer Studio must show up with the
// parts Team understands and the word unknown for the rest.

/** The supervised process, as far as Team can see it. */
export interface ServerView {
  readonly version: string;
  readonly running: boolean;
  readonly pid?: number;
  readonly startedAt?: number;
  readonly restarts: number;
  readonly healthy: boolean;
  readonly healthCheckedAt?: number;
  readonly storageBytes?: number;
  readonly storageRoot: string;
}

/** The addresses somebody has to be told to reach this Team server. */
export interface ReachView {
  readonly signIn: string;
  readonly data: string;
  readonly fingerprint: string;
  /** Ports bound to the loopback, which nobody else can reach. */
  readonly loopback: ReadonlyArray<{ readonly port: number; readonly what: string }>;
}

export interface UserView {
  readonly username: string;
  readonly displayName: string;
  readonly email?: string;
  readonly role: string;
  readonly disabled: boolean;
  readonly serviceAccount: boolean;
  readonly createdAt: number;
  readonly lastSeenAt?: number;
  readonly tokensInvalidatedAt?: number;
  readonly projects: ReadonlyArray<{ readonly name: string; readonly level: string }>;
}

/** What a revision history tells us, which does not depend on Studio at all. */
export interface RevisionView {
  /**
   * How many revisions there are, absent when Team has not counted them.
   *
   * Optional for the same reason everything else here is: a required number
   * has to be given a value even when nobody knows it, and the value that
   * gets given is zero — which reads as a project nobody has ever pushed to
   * rather than as a question Team did not ask.
   */
  readonly revisions?: number;
  readonly branch?: string;
  readonly bytes?: number;
  readonly lastAt?: number;
  readonly lastBy?: string;
  readonly lastMessage?: string;
}

/**
 * What the project file tells us.
 *
 * `readable` is false when Team could not make sense of the file — most often
 * because it was written by a newer Studio. Everything else is then absent,
 * and `reason` is a sentence a person can act on. It is never an error: the
 * revision history above it is still true, and Team saying "unknown" is the
 * behaviour that keeps it from having to be upgraded in step with Studio.
 */
export interface ProjectFileView {
  readonly readable: boolean;
  readonly reason?: string;
  readonly title?: string;
  readonly stageWidth?: number;
  readonly stageHeight?: number;
  readonly scenes?: number;
  readonly assets?: number;
  readonly assetBytes?: number;
  readonly assetsByKind?: ReadonlyArray<{ readonly kind: string; readonly count: number; readonly bytes: number }>;
}

export interface ProjectView {
  readonly name: string;
  readonly description: string;
  readonly owner: string;
  readonly createdAt: number;
  readonly access: ReadonlyArray<{ readonly username: string; readonly level: string }>;
  readonly history: RevisionView;
  readonly file: ProjectFileView;
}

/** One decision Team was asked to make, as the log recorded it. */
export interface AuditView {
  readonly at: number;
  readonly username: string;
  readonly resource: string;
  readonly allowed: boolean;
  readonly detail: string;
}

/**
 * One line on the settings surface.
 *
 * `editable` false means the value is shown but cannot be changed here, and
 * pressing return on it must do nothing. `restartRequired` means the change is
 * written now and takes effect when loreserver is next started — the interface
 * has to say which, because a setting that silently did not apply is worse
 * than one that could not be changed.
 */
export interface SettingView {
  readonly group: string;
  readonly label: string;
  readonly value: string;
  /**
   * The number `value` was written from, where it was written from one.
   *
   * Present on the two lifetimes and nowhere else. It is here because the web
   * interface writes a duration in its own language — "30 天" — and cannot get
   * there from the words "30 days" without taking them apart again. The value
   * stays the English the terminal interface draws, so nothing that reads this
   * view has to learn a second way to read a row.
   */
  readonly seconds?: number;
  readonly editable: boolean;
  readonly restartRequired?: boolean;
  /** Why this value is worth thinking about, shown when it is being changed. */
  readonly caution?: string;
}

export interface TeamView {
  readonly teamVersion: string;
  readonly root: string;
  /**
   * The moment this view was gathered. Every relative time on screen — "2h
   * ago", "up 3d" — is worked out against this rather than the clock, so that
   * a drawn screen is a function of its view and nothing else. A test that had
   * to read the clock could not assert on what it drew.
   */
  readonly now: number;
  readonly server: ServerView;
  readonly reach: ReachView;
  readonly users: ReadonlyArray<UserView>;
  readonly projects: ReadonlyArray<ProjectView>;
  readonly audit: ReadonlyArray<AuditView>;
  readonly settings: ReadonlyArray<SettingView>;
  readonly invitesLive: number;
  readonly signingKeys: number;
}
