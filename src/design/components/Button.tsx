// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Button({ variant = 'secondary', children, ...rest }: ButtonProps) {
  return (
    <button type="button" className={`btn btn--${variant}`} {...rest}>
      {children}
    </button>
  );
}

interface ToggleButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed'> {
  /** External ref: lets a floating panel be anchored on this button. */
  buttonRef?: React.MutableRefObject<HTMLButtonElement | null>;
  /**
   * **Contextual** state: the button applies to the element where the cursor is (table, image...). Visually identical to an active
   * button, but without `aria-pressed`: this button is not a toggle, it opens a panel. The change of context is already carried by
   * the label, which changes too.
   */
  active?: boolean;
  /** Accessible label; mandatory because the button only shows an icon. */
  label: string;
  /** Shortcut shown in the tooltip: a shortcut that cannot be discovered does not exist. */
  shortcut?: string;
  pressed: boolean;
  children: ReactNode;
}

/**
 * Toggle button of the ribbon. `aria-pressed` carries the state: color alone MUST never be the vehicle of information (UX
 * directive §2.1).
 */
export function ToggleButton({
  label,
  shortcut,
  pressed,
  buttonRef,
  active = false,
  children,
  ...rest
}: ToggleButtonProps) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      ref={(element) => {
        if (buttonRef) buttonRef.current = element;
      }}
      data-active={active ? 'true' : undefined}
      className="btn btn--icon"
      aria-pressed={pressed}
      aria-label={label}
      title={title}
      {...rest}
    >
      {children}
    </button>
  );
}
