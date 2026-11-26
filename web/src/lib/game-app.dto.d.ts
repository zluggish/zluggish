export interface GameField {
  name: string;
  label: string;
  type?: 'text' | 'password' | 'checkbox' | 'hidden' | 'select';
  value?: string | boolean;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
  pattern?: string;
  autocomplete?: 'username' | 'new-password' | 'current-password' | 'one-time-code';
  matches?: string;
  autofocus?: boolean;
  when?: { field: string; value: string | boolean };
  options?: Array<{ value: string; label: string }>;
}

export interface GameForm {
  id: string;
  action: string;
  title?: string;
  fields: Array<GameField>;
  buttons: Array<{ label: string; name?: string; value?: string; skipValidation?: boolean }>;
  navigation?: boolean;
  confirmation?: string;
  /** The page's main action, highlighted in Zwift orange. */
  primary?: boolean;
  /** Inputs are not saved settings (such as a sign-in password), so the form never reports unsaved changes. */
  transient?: boolean;
  /** The user-list row: avatar, plus the sign-in email under the name when the user has a real one. */
  user?: {
    initials: string;
    photo: string | null;
    email: string | null;
    /** The rider's workout planned for today, when one is synced. */
    workout?: { name: string; minutes: number } | null;
  };
}

export interface GamePageModel {
  kind: 'login' | 'unlock' | 'dashboard' | 'message';
  title: string;
  csrf: string;
  /** The server's release version, shown in the top bar. */
  version: string;
  zwiftVersion?: string;
  /** Where riders open the web app, from the configured public URL. Absent when none is set. */
  webApp?: string | null;
  forms: Array<GameForm>;
  /** Shown as a back button beside the title; it navigates and never signs out. */
  back?: { href: string; label: string };
  message?: string;
  failed?: boolean;
  /** A security problem with the server that every rider should see, such as the shared certificate. */
  warning?: string;
  errorStatus?: 400 | 403 | 409;
}

export type FormResult<T> =
  | { ok: true; data: T; message?: string; redirectTo?: string }
  | { ok: false; message: string; fieldErrors?: Record<string, Array<string>>; reload?: boolean };

export interface GameSaved {
  page?: GamePageModel;
}
