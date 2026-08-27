/**
 * Partage d'un document.
 *
 * Deux états, jamais mélangés :
 *
 *  - **document non partagé** — on compose la liste des personnes et leurs
 *    permissions, puis on partage. Le jeton de session est proposé, modifiable,
 *    et sa part aléatoire n'est pas retirable ;
 *  - **document déjà partagé** — on voit la liste, on copie les liens, on invite
 *    quelqu'un de plus.
 *
 * Le lien de chaque personne lui est **propre** : il porte son adresse, et c'est
 * elle qui décide de sa permission. Un lien unique partagé à tous ferait de la
 * permission une propriété du lien, donc transférable — exactement ce que le
 * serveur refuse.
 */

import { useCallback, useMemo, useState, type JSX } from 'react';
import { Modal } from '../../design/components/Modal';
import { Icon } from '../../design/icons/Icon';
import {
  ApiError,
  generateSessionToken,
  type Permission,
  type SessionSummary,
} from '../../domain/collab/api';

const PERMISSIONS: readonly { value: Permission; label: string; aide: string }[] = [
  { value: 'write', label: 'Modifier', aide: 'Écrire, insérer des images, changer la mise en page' },
  { value: 'comment', label: 'Commenter', aide: 'Lire et annoter, sans modifier le texte' },
  { value: 'read', label: 'Lire', aide: 'Consulter le document seulement' },
];

export interface Invitation {
  email: string;
  permission: Permission;
}

export interface ShareDialogProps {
  documentTitle: string;
  /** Partage existant, quand le document l'est déjà. */
  session: SessionSummary | null;
  /** Adresse de la personne qui partage ; elle est automatiquement en écriture. */
  ownerEmail: string;
  /** Vrai quand cette personne peut inviter (permission d'écriture). */
  canInvite: boolean;
  onShare: (tokenSession: string, invitations: Invitation[]) => Promise<void>;
  onInvite: (invitation: Invitation) => Promise<void>;
  onClose: () => void;
}

export function ShareDialog({
  documentTitle,
  session,
  ownerEmail,
  canInvite,
  onShare,
  onInvite,
  onClose,
}: ShareDialogProps): JSX.Element {
  const [tokenSession, setTokenSession] = useState(() => generateSessionToken(documentTitle));
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<Permission>('write');
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [copie, setCopie] = useState<string | null>(null);

  const origine = typeof window !== 'undefined' ? window.location.origin : '';

  const lienDe = useCallback(
    (adresse: string): string => {
      const jeton = session?.token_session ?? tokenSession;
      return `${origine}/?session=${encodeURIComponent(jeton)}&email=${encodeURIComponent(adresse)}`;
    },
    [origine, session, tokenSession],
  );

  const copier = useCallback(async (texte: string, cle: string) => {
    try {
      await navigator.clipboard.writeText(texte);
      setCopie(cle);
      window.setTimeout(() => setCopie(null), 2000);
    } catch {
      setErreur('Copie impossible : le presse-papiers a été refusé par le navigateur.');
    }
  }, []);

  const ajouter = useCallback(() => {
    const adresse = email.trim().toLowerCase();
    setErreur(null);

    if (!adresse.includes('@') || adresse.includes(' ')) {
      setErreur('Adresse électronique invalide.');
      return;
    }
    if (adresse === ownerEmail.toLowerCase()) {
      setErreur('Vous êtes déjà sur la liste.');
      return;
    }
    const deja =
      invitations.some((i) => i.email === adresse) ||
      session?.participants.some((p) => p.email.toLowerCase() === adresse);
    if (deja) {
      setErreur(`« ${adresse} » participe déjà à ce partage.`);
      return;
    }

    setInvitations((liste) => [...liste, { email: adresse, permission }]);
    setEmail('');
  }, [email, permission, invitations, session, ownerEmail]);

  const retirer = useCallback((adresse: string) => {
    setInvitations((liste) => liste.filter((i) => i.email !== adresse));
  }, []);

  const partager = useCallback(async () => {
    setErreur(null);
    setEnCours(true);
    try {
      // La personne qui partage est **toujours** ajoutée en écriture : sans
      // elle sur la liste, elle perdrait l'accès à son propre document dès le
      // partage effectué.
      await onShare(tokenSession, [
        { email: ownerEmail, permission: 'write' },
        ...invitations,
      ]);
    } catch (error) {
      setErreur(messageDe(error));
    } finally {
      setEnCours(false);
    }
  }, [onShare, tokenSession, ownerEmail, invitations]);

  const inviter = useCallback(async () => {
    const adresse = email.trim().toLowerCase();
    if (!adresse.includes('@')) {
      setErreur('Adresse électronique invalide.');
      return;
    }
    setErreur(null);
    setEnCours(true);
    try {
      await onInvite({ email: adresse, permission });
      setEmail('');
    } catch (error) {
      setErreur(messageDe(error));
    } finally {
      setEnCours(false);
    }
  }, [onInvite, email, permission]);

  const jetonValide = useMemo(
    () => /^[A-Za-z0-9_-]{12,128}$/.test(tokenSession),
    [tokenSession],
  );

  return (
    <Modal
      title={session ? 'Partage du document' : 'Partager le document'}
      onClose={onClose}
      width={680}
    >
      <div className="share-dialog">
        {erreur && (
          <p className="share-dialog__erreur" role="alert">
            {erreur}
          </p>
        )}

        {!session && (
          <label className="field">
            <span className="field__label">
              Signature du partage — elle apparaît dans le lien, et ne doit pas être devinable
            </span>
            <input
              type="text"
              value={tokenSession}
              spellCheck={false}
              onChange={(event) => setTokenSession(event.target.value.trim())}
              aria-invalid={!jetonValide}
            />
            {!jetonValide && (
              <span className="field__aide">
                12 à 128 caractères : lettres, chiffres, « - » ou « _ ».
              </span>
            )}
          </label>
        )}

        {/* Ajout d'une personne */}
        {(canInvite || !session) && (
          <div className="share-dialog__ajout">
            <label className="field share-dialog__email">
              <span className="field__label">Inviter par adresse électronique</span>
              <input
                type="email"
                inputMode="email"
                placeholder="prenom.nom@exemple.fr"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  if (session) void inviter();
                  else ajouter();
                }}
              />
            </label>

            <label className="field share-dialog__permission">
              <span className="field__label">Permission</span>
              <select
                value={permission}
                onChange={(event) => setPermission(event.target.value as Permission)}
              >
                {PERMISSIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="btn"
              disabled={enCours || email.trim().length === 0}
              onClick={() => (session ? void inviter() : ajouter())}
            >
              {session ? 'Inviter' : 'Ajouter'}
            </button>
          </div>
        )}

        <p className="share-dialog__aide">
          {PERMISSIONS.find((p) => p.value === permission)?.aide}
        </p>

        {/* Liste des personnes */}
        <ul className="share-dialog__liste">
          <li className="share-dialog__personne">
            <span className="share-dialog__adresse">
              {ownerEmail} <em>(vous)</em>
            </span>
            <span className="share-dialog__role">Propriétaire</span>
          </li>

          {session?.participants
            .filter((p) => p.email.toLowerCase() !== ownerEmail.toLowerCase())
            .map((p) => (
              <li key={p.user_id} className="share-dialog__personne">
                <span className="share-dialog__adresse">{p.email}</span>
                <span className="share-dialog__role">
                  {PERMISSIONS.find((entry) => entry.value === p.permission)?.label ?? p.permission}
                </span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => void copier(lienDe(p.email), p.user_id)}
                  title="Copier le lien personnel de cette personne"
                >
                  {copie === p.user_id ? 'Copié ✓' : 'Copier le lien'}
                </button>
              </li>
            ))}

          {invitations.map((invitation) => (
            <li key={invitation.email} className="share-dialog__personne">
              <span className="share-dialog__adresse">{invitation.email}</span>
              <span className="share-dialog__role">
                {PERMISSIONS.find((p) => p.value === invitation.permission)?.label}
              </span>
              <button
                type="button"
                className="btn btn--icon"
                aria-label={`Retirer ${invitation.email}`}
                onClick={() => retirer(invitation.email)}
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
        </ul>

        {session && (
          <div className="share-dialog__partage">
            <p className="share-dialog__note">
              Chaque personne reçoit un lien qui lui est propre : sa permission est
              inscrite dans le partage, pas dans le lien. Le transmettre à
              quelqu’un d’autre ne lui donne donc aucun accès.
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => void copier(lienDe(ownerEmail), 'self')}
            >
              {copie === 'self' ? 'Copié ✓' : 'Copier mon lien'}
            </button>
          </div>
        )}

        <footer className="share-dialog__actions">
          <span className="share-dialog__spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {session ? 'Fermer' : 'Annuler'}
          </button>
          {!session && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={enCours || !jetonValide}
              onClick={() => void partager()}
            >
              {enCours ? 'Partage en cours…' : 'Partager'}
            </button>
          )}
        </footer>
      </div>
    </Modal>
  );
}

function messageDe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isOffline) {
      return 'Serveur de partage injoignable. Le document reste modifiable hors ligne.';
    }
    return error.message;
  }
  return (error as Error).message;
}
