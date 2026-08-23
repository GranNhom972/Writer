import { describe, expect, it } from 'vitest';
import { hashUserId, initials, presenceColorIndex, presenceColorVar } from '../src/domain/presence';

describe('présence collaborative', () => {
  it('attribue une couleur STABLE pour un identifiant donné', () => {
    // Exigence directive UX §7 : la couleur d'Alice est la même sur tous les écrans.
    const first = presenceColorVar('alice');
    for (let i = 0; i < 50; i += 1) {
      expect(presenceColorVar('alice')).toBe(first);
    }
  });

  it('reste dans la palette des 8 couleurs de présence', () => {
    for (const user of ['alice', 'bob', 'carole', 'dimitri', 'éric', 'x'.repeat(200)]) {
      const index = presenceColorIndex(user);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(8);
    }
  });

  it('distingue des utilisateurs différents dans la plupart des cas', () => {
    const users = ['alice', 'bob', 'carole', 'dimitri', 'emma', 'farid'];
    const distinct = new Set(users.map(presenceColorIndex));
    expect(distinct.size).toBeGreaterThanOrEqual(4);
  });

  it('produit un hachage déterministe et non signé', () => {
    expect(hashUserId('alice')).toBe(hashUserId('alice'));
    expect(hashUserId('alice')).toBeGreaterThanOrEqual(0);
    expect(hashUserId('alice')).not.toBe(hashUserId('bob'));
  });

  it('dérive des initiales lisibles', () => {
    expect(initials('Alice Dupont')).toBe('AD');
    expect(initials('alice')).toBe('A');
    expect(initials('   ')).toBe('?');
  });
});
