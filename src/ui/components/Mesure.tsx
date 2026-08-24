import { useEffect, useRef, useState, type JSX } from 'react';

export interface MesureProps {
  label: string;
  valeur: number;
  bornes: { min: number; max: number };
  unite?: string;
  step?: number;
  onChange: (valeur: number) => void;
}

/**
 * Champ de mesure avec état local :
 * Permet de taper, effacer et corriger des valeurs au clavier librement sans que la
 * valeur soit écrasée ou réinitialisée à chaque frappe de touche.
 */
export function Mesure({ label, valeur, bornes, unite = 'mm', step, onChange }: MesureProps): JSX.Element {
  const [texte, setTexte] = useState(String(valeur));
  const estEnSaisie = useRef(false);

  useEffect(() => {
    if (!estEnSaisie.current) {
      setTexte(String(valeur));
    }
  }, [valeur]);

  const validerEtAppliquer = (valeurTexte: string) => {
    const nombre = Number.parseFloat(valeurTexte);
    if (Number.isFinite(nombre)) {
      const bornee = Math.min(bornes.max, Math.max(bornes.min, Math.round(nombre * 10) / 10));
      setTexte(String(bornee));
      onChange(bornee);
    } else {
      setTexte(String(valeur));
    }
  };

  return (
    <label className="furniture__mesure">
      <span className="field__label">{label}</span>
      <span className="furniture__mesure-champ">
        <input
          className="stepper__input"
          type="number"
          min={bornes.min}
          max={bornes.max}
          step={step ?? (unite === 'pt' ? 1 : 0.5)}
          value={texte}
          onFocus={() => {
            estEnSaisie.current = true;
          }}
          onChange={(event) => {
            const nouv = event.target.value;
            setTexte(nouv);
            const nombre = Number.parseFloat(nouv);
            if (Number.isFinite(nombre) && nombre >= bornes.min && nombre <= bornes.max) {
              onChange(Math.round(nombre * 10) / 10);
            }
          }}
          onBlur={(event) => {
            estEnSaisie.current = false;
            validerEtAppliquer(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          onWheel={(event) => {
            if (document.activeElement === event.currentTarget) {
              event.currentTarget.blur();
            }
          }}
        />
        <span className="furniture__unite">{unite}</span>
      </span>
    </label>
  );
}
