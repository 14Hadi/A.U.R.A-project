import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
/**
 * KONFIGURASI KLIEN GOOGLE OAUTH 2.0, FIREBASE AUTH & CLOUD FIRESTORE:
 * Berkas `firebase-applet-config.json` memuat kredensial publik proyek Google Cloud,
 * termasuk `oAuthClientId`, `apiKey`, `authDomain`, `projectId`, dan `firestoreDatabaseId`.
 * Jika menjalankan proyek ini di luar Google AI Studio pada perangkat sendiri,
 * pastikan nilai `oAuthClientId` dan `authDomain` sesuai dengan kredensial
 * OAuth 2.0 Web Client ID dari Google Cloud Console -> APIs & Services -> Credentials.
 */
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

/**
 * Inisialisasi Cloud Firestore menggunakan `firestoreDatabaseId` resmi yang telah diprovisikan
 * untuk menyimpan riwayat percakapan, Ingatan A.U.R.A, dan agenda rutinitas lintas perangkat.
 */
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

/**
 * Validasi koneksi awal ke Cloud Firestore saat modul dimuat.
 */
async function testFirestoreConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration. The Firestore client is offline.');
    }
    // Error izin akses pada dokumen uji ('Missing or insufficient permissions') wajar karena aturan default-deny aktif.
  }
}
void testFirestoreConnection();

/**
 * Daftar scope OAuth 2.0 minimum (Least Privilege) untuk membaca profil dasar
 * dan alamat email pengguna melalui Google People API.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
];

const provider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  provider.addScope(scope);
}
provider.setCustomParameters({
  prompt: 'select_account',
});

/**
 * KEAMANAN TOKEN AKSES (IN-MEMORY STORAGE):
 * Token akses OAuth 2.0 (`cachedAccessToken`) HANYA disimpan di dalam memori JavaScript
 * selama tab aktif dan TIDAK PERNAH disimpan ke `localStorage` atau `sessionStorage`.
 * Hal ini melindungi kredensial pengguna dari pencurian token lintas skrip (XSS).
 */
let isSigningIn = false;
let cachedAccessToken: string | null = null;

/**
 * Menginisialisasi pendengar status autentikasi saat aplikasi dimuat.
 * Otomatis menghapus token di memori ketika pengguna keluar (sign out)
 * atau ketika sesi memerlukan autentikasi ulang untuk mendapatkan token segar.
 */
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

/**
 * Memicu jendela popup resmi Google Sign-In (OAuth 2.0).
 * Harus dipanggil langsung dari interaksi klik tombol pengguna agar tidak diblokir browser.
 */
export const googleSignIn = async (): Promise<{ user: User; accessToken: string }> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);

    if (!credential?.accessToken) {
      throw new Error(
        'Gagal memperoleh OAuth 2.0 Access Token dari respons autentikasi Google.'
      );
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
};

/**
 * Mengambil token akses OAuth 2.0 dari memori untuk dikirim melalui header
 * `Authorization: Bearer <token>` ke endpoint Google People API maupun server A.U.R.A.
 */
export const getAccessToken = (): string | null => {
  return cachedAccessToken;
};

/**
 * Mengakhiri sesi pengguna dan membersihkan cache token akses di memori secara tuntas.
 */
export const logoutGoogle = async (): Promise<void> => {
  cachedAccessToken = null;
  await auth.signOut();
};

/**
 * Mengekspos metadata publik konfigurasi OAuth Client ID & Firestore Database ID untuk keperluan
 * transparansi arsitektur pada panel inspektor aplikasi.
 */
export const getPublicOAuthMetadata = () => ({
  projectId: firebaseConfig.projectId,
  authDomain: firebaseConfig.authDomain,
  oAuthClientId: firebaseConfig.oAuthClientId,
  firestoreDatabaseId: firebaseConfig.firestoreDatabaseId,
  scopes: SCOPES,
});
