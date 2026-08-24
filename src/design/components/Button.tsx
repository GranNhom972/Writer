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
  /** Ref externe : permet d'ancrer un panneau flottant sur ce bouton. */
  buttonRef?: React.MutableRefObject<HTMLButtonElement | null>;
  /**
   * État **contextuel** : le bouton porte sur l'élément où se trouve le curseur
   * (tableau, image…). Visuellement identique à un bouton actif, mais sans
   * `aria-pressed` — ce bouton n'est pas une bascule, il ouvre un panneau. Le
   * changement de contexte est déjà porté par le libellé, qui change lui aussi.
   */
  active?: boolean;
  /** Libellé accessible ; obligatoire car le bouton n'affiche qu'une icône. */
  label: string;
  /** Raccourci affiché dans l'info-bulle : un raccourci non découvrable n'existe pas. */
  shortcut?: string;
  pressed: boolean;
  children: ReactNode;
}

/**
 * Bouton bascule du ruban. `aria-pressed` porte l'état : la couleur seule ne DOIT
 * jamais être le véhicule d'une information (directive UX §2.1).
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
