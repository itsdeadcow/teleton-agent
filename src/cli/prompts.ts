import * as clack from "@clack/prompts";
import { setTimeout } from "timers/promises";

export interface SelectOption<T = string> {
  value: T;
  label: string;
  hint?: string;
}

export interface TextPromptOptions {
  message: string;
  placeholder?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}

export interface SelectPromptOptions<T = string> {
  message: string;
  options: SelectOption<T>[];
  initialValue?: T;
}

export interface ConfirmPromptOptions {
  message: string;
  initialValue?: boolean;
}

export class ClackPrompter {
  async intro(title: string): Promise<void> {
    clack.intro(title);
  }

  async outro(message: string): Promise<void> {
    clack.outro(message);
  }

  async note(message: string, title?: string): Promise<void> {
    clack.note(message, title);
  }
  async text(options: TextPromptOptions): Promise<string> {
    const result = await clack.text({
      message: options.message,
      placeholder: options.placeholder,
      initialValue: options.initialValue,
      validate: options.validate,
    });

    if (clack.isCancel(result)) {
      throw new CancelledError();
    }

    return result as string;
  }
  async password(options: {
    message: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string> {
    const result = await clack.password({
      message: options.message,
      validate: options.validate,
    });

    if (clack.isCancel(result)) {
      throw new CancelledError();
    }

    return result as string;
  }
  async select<T = string>(options: SelectPromptOptions<T>): Promise<T> {
    const result = await clack.select({
      message: options.message,
      options: options.options.map((opt) => {
        const mapped: { value: T; label: string; hint?: string } = {
          value: opt.value,
          label: opt.label,
        };
        if (opt.hint) {
          mapped.hint = opt.hint;
        }
        return mapped;
      }) as any,
      initialValue: options.initialValue,
    });

    if (clack.isCancel(result)) {
      throw new CancelledError();
    }

    return result as T;
  }
  async confirm(options: ConfirmPromptOptions): Promise<boolean> {
    const result = await clack.confirm({
      message: options.message,
      initialValue: options.initialValue ?? false,
    });

    if (clack.isCancel(result)) {
      throw new CancelledError();
    }

    return result as boolean;
  }
  async multiselect<T = string>(options: {
    message: string;
    options: SelectOption<T>[];
    required?: boolean;
  }): Promise<T[]> {
    const result = await clack.multiselect({
      message: options.message,
      options: options.options.map((opt) => {
        const mapped: { value: T; label: string; hint?: string } = {
          value: opt.value,
          label: opt.label,
        };
        if (opt.hint) {
          mapped.hint = opt.hint;
        }
        return mapped;
      }) as any,
      required: options.required,
    });

    if (clack.isCancel(result)) {
      throw new CancelledError();
    }

    return result as T[];
  }
  spinner(): ClackSpinner {
    const s = clack.spinner();
    return {
      start: (message: string) => s.start(message),
      stop: (message: string) => s.stop(message),
      message: (message: string) => s.message(message),
    };
  }

  log(message: string): void {
    clack.log.message(message);
  }

  warn(message: string): void {
    clack.log.warn(message);
  }

  error(message: string): void {
    clack.log.error(message);
  }

  success(message: string): void {
    clack.log.success(message);
  }
}

export interface ClackSpinner {
  start: (message: string) => void;
  stop: (message: string) => void;
  message: (message: string) => void;
}

export class CancelledError extends Error {
  constructor() {
    super("Operation cancelled by user");
    this.name = "CancelledError";
  }
}

export function createPrompter(): ClackPrompter {
  return new ClackPrompter();
}
