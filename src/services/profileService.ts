import type { User } from 'firebase/auth';
import type { UserProfile } from '../types/aura.ts';
import {
  extractProfileFromPeopleApi,
  type PeopleApiPayload,
} from '../utils/auraContext.ts';

const GOOGLE_PEOPLE_ME_ENDPOINT =
  'https://people.googleapis.com/v1/people/me?personFields=names,emailAddresses,photos';

/**
 * Mengambil profil dasar pengguna (khususnya Display Name) langsung dari
 * Google People API menggunakan OAuth 2.0 Access Token yang aktif di memori,
 * dilengkapi batas waktu 7 detik agar koneksi seluler lambat tidak menghambat login.
 */
export async function fetchGoogleUserProfile(
  firebaseUser: User,
  accessToken: string
): Promise<UserProfile> {
  let peoplePayload: PeopleApiPayload | null = null;

  try {
    const response = await fetch(GOOGLE_PEOPLE_ME_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(7000),
    });

    if (response.ok) {
      peoplePayload = (await response.json()) as PeopleApiPayload;
    }
  } catch (err) {
    // Jika jaringan ke People API terkendala sementara, gunakan profil terverifikasi dari objek User Google Auth.
    console.warn('Menggunakan fallback profil Google Auth karena kendala jaringan People API:', err);
  }

  const extracted = extractProfileFromPeopleApi(peoplePayload, {
    displayName: firebaseUser.displayName,
    email: firebaseUser.email,
    photoUrl: firebaseUser.photoURL,
  });

  return {
    uid: firebaseUser.uid,
    displayName: extracted.displayName,
    givenName: extracted.givenName,
    email: extracted.email,
    photoUrl: extracted.photoUrl,
    source: extracted.source,
    verifiedAt: new Date().toISOString(),
  };
}
