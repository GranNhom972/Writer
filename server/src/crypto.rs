// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 The Writer contributors

//! SHA-256, HMAC-SHA256 and base64url.
//!
//! Written here rather than imported, for the same reason `base64_url_decode` was
//! written by hand in `auth.rs`: these three building blocks fit in two hundred
//! fully specified lines (FIPS 180-4, RFC 2104, RFC 4648), and importing them would
//! pull `sha2`, `hmac`, `digest` and their whole family into a project that today
//! has **no** cryptography dependency.
//!
//! They serve a single purpose: checking the signature of the access tickets issued
//! by CloudServ (`auth.rs`) and signing the callbacks the server sends to it
//! (`hook.rs`). No secret is derived here and no key is generated: this is
//! integrity checking, not applied cryptography.
//!
//! The RFC test vectors are checked at the bottom of the file.

/// SHA-256 round constants: the first 32 bits of the fractional parts of the cube
/// roots of the first 64 prime numbers (FIPS 180-4, §4.2.2).
const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// Initial values: the fractional parts of the square roots of the first 8 prime
/// numbers (FIPS 180-4, §5.3.3).
const H0: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

pub const SHA256_BLOCK_BYTES: usize = 64;
pub const SHA256_OUTPUT_BYTES: usize = 32;

/// SHA-256 digest of a message.
pub fn sha256(message: &[u8]) -> [u8; SHA256_OUTPUT_BYTES] {
    let mut h = H0;

    // FIPS 180-4 §5.1.1 padding: a 1 bit, zeros, then the message length in bits as a
    // 64-bit big-endian number.
    let mut bloc = Vec::with_capacity(message.len() + 72);
    bloc.extend_from_slice(message);
    bloc.push(0x80);
    while bloc.len() % SHA256_BLOCK_BYTES != 56 {
        bloc.push(0);
    }
    let bits = (message.len() as u64).wrapping_mul(8);
    bloc.extend_from_slice(&bits.to_be_bytes());

    for morceau in bloc.as_chunks::<SHA256_BLOCK_BYTES>().0 {
        let mut w = [0u32; 64];
        for (i, mot) in morceau.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*mot);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        for (acc, valeur) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *acc = acc.wrapping_add(valeur);
        }
    }

    let mut sortie = [0u8; SHA256_OUTPUT_BYTES];
    for (i, mot) in h.iter().enumerate() {
        sortie[i * 4..i * 4 + 4].copy_from_slice(&mot.to_be_bytes());
    }
    sortie
}

/// HMAC-SHA256 (RFC 2104).
pub fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; SHA256_OUTPUT_BYTES] {
    // A key longer than one block is hashed first; a shorter key is padded with
    // zeros.
    let mut cle = [0u8; SHA256_BLOCK_BYTES];
    if key.len() > SHA256_BLOCK_BYTES {
        cle[..SHA256_OUTPUT_BYTES].copy_from_slice(&sha256(key));
    } else {
        cle[..key.len()].copy_from_slice(key);
    }

    let mut interne = Vec::with_capacity(SHA256_BLOCK_BYTES + message.len());
    let mut externe = Vec::with_capacity(SHA256_BLOCK_BYTES + SHA256_OUTPUT_BYTES);
    for octet in cle.iter() {
        interne.push(octet ^ 0x36);
        externe.push(octet ^ 0x5c);
    }
    interne.extend_from_slice(message);
    externe.extend_from_slice(&sha256(&interne));
    sha256(&externe)
}

/// Constant-time comparison.
///
/// An ordinary `==` stops at the first differing byte: the response time then gives
/// away the expected signature, byte by byte. This is the classic attack against a
/// MAC check, and it is very real on a service that can be queried in a loop.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut difference = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        difference |= x ^ y;
    }
    difference == 0
}

/// The base64url alphabet. The server only **verifies** tokens and never issues
/// them: the matching encoder is only used by the tests, where it plays the role of
/// CloudServ and builds the tickets to examine.
#[cfg(test)]
const BASE64_URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64_STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// **Standard** base64 encoding, **with padding**, as used by `data:` URIs.
///
/// Not the same as `base64_url_encode`: an image inlined with the URL alphabet and
/// no padding cannot be decoded by a browser.
pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for morceau in input.chunks(3) {
        let b0 = morceau[0] as u32;
        let b1 = *morceau.get(1).unwrap_or(&0) as u32;
        let b2 = *morceau.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(BASE64_STD[((triple >> 18) & 0x3F) as usize] as char);
        out.push(BASE64_STD[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if morceau.len() > 1 {
            BASE64_STD[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if morceau.len() > 2 {
            BASE64_STD[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Lower-case hexadecimal representation: the form in which the signature of the
/// callbacks travels to CloudServ.
pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for octet in bytes {
        out.push_str(&format!("{octet:02x}"));
    }
    out
}

/// base64url encoding **without padding**, as JOSE requires (RFC 7515 §2).
#[cfg(test)]
pub fn base64_url_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for morceau in input.chunks(3) {
        let b0 = morceau[0] as u32;
        let b1 = *morceau.get(1).unwrap_or(&0) as u32;
        let b2 = *morceau.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(BASE64_URL[((triple >> 18) & 0x3F) as usize] as char);
        out.push(BASE64_URL[((triple >> 12) & 0x3F) as usize] as char);
        if morceau.len() > 1 {
            out.push(BASE64_URL[((triple >> 6) & 0x3F) as usize] as char);
        }
        if morceau.len() > 2 {
            out.push(BASE64_URL[(triple & 0x3F) as usize] as char);
        }
    }
    out
}

/// base64url decoding, with or without padding.
pub fn base64_url_decode(input: &str) -> Result<Vec<u8>, ()> {
    let valeur = |c: u8| -> Result<u32, ()> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok((c - b'a' + 26) as u32),
            b'0'..=b'9' => Ok((c - b'0' + 52) as u32),
            b'+' | b'-' => Ok(62),
            b'/' | b'_' => Ok(63),
            _ => Err(()),
        }
    };

    let brut: Vec<u8> = input.bytes().filter(|c| *c != b'=').collect();
    let mut out = Vec::with_capacity(brut.len() * 3 / 4);

    for morceau in brut.chunks(4) {
        // A group of a single character holds no complete byte: that is an invalid
        // encoding, not a tolerable remainder.
        if morceau.len() == 1 {
            return Err(());
        }
        let mut accumulateur = 0u32;
        for (i, c) in morceau.iter().enumerate() {
            accumulateur |= valeur(*c)? << (18 - 6 * i);
        }
        out.push(((accumulateur >> 16) & 0xFF) as u8);
        if morceau.len() > 2 {
            out.push(((accumulateur >> 8) & 0xFF) as u8);
        }
        if morceau.len() > 3 {
            out.push((accumulateur & 0xFF) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn sha256_vecteurs_fips() {
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // A message that straddles two blocks: this is the case a badly written padding
        // gets wrong, and it goes unnoticed on short messages.
        assert_eq!(
            hex(&sha256(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn sha256_message_long() {
        // One million "a": a FIPS 180-4 vector that exercises the length counter well
        // beyond a single byte.
        let message = vec![b'a'; 1_000_000];
        assert_eq!(
            hex(&sha256(&message)),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn hmac_vecteurs_rfc4231() {
        // RFC 4231 test case 1.
        let cle = [0x0b_u8; 20];
        assert_eq!(
            hex(&hmac_sha256(&cle, b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );

        // Test case 2: key and message in plain text.
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );

        // Test case 6: a 131-byte key, so longer than one block. It must be hashed before
        // use, and it is the branch people forget to write.
        let cle_longue = [0xaa_u8; 131];
        assert_eq!(
            hex(&hmac_sha256(
                &cle_longue,
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            )),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn base64url_aller_retour() {
        for cas in [
            &b""[..],
            &b"f"[..],
            &b"fo"[..],
            &b"foo"[..],
            &b"foob"[..],
            &b"fooba"[..],
            &b"foobar"[..],
        ] {
            let encode = base64_url_encode(cas);
            assert!(!encode.contains('='), "JOSE interdit le remplissage");
            assert_eq!(base64_url_decode(&encode).unwrap(), cas);
        }
    }

    #[test]
    fn base64url_encode_sans_caracteres_interdits() {
        // The bytes 0xFB 0xFF give "+" and "/" in standard base64: they must come out as
        // "-" and "_", otherwise the token breaks in a URL.
        let encode = base64_url_encode(&[0xfb, 0xff, 0xfe]);
        assert!(!encode.contains('+') && !encode.contains('/'));
        assert_eq!(base64_url_decode(&encode).unwrap(), vec![0xfb, 0xff, 0xfe]);
    }

    #[test]
    fn base64_standard_vecteurs_rfc4648() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_standard_garde_lalphabet_standard() {
        // An image inlined as `data:` must decode in a browser: the bytes that give "+"
        // and "/" must not come out as "-" and "_".
        assert_eq!(base64_encode(&[0xfb, 0xff, 0xbf]), "+/+/");
    }

    #[test]
    fn hexadecimal_sur_deux_chiffres() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn base64url_refuse_une_entree_absurde() {
        assert!(base64_url_decode("###").is_err());
        assert!(
            base64_url_decode("A").is_err(),
            "un seul caractère ne porte aucun octet"
        );
    }

    #[test]
    fn comparaison_a_temps_constant() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
