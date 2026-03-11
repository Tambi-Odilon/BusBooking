import { Injectable, signal, computed } from '@angular/core';
import { UserProfile, LoginCredentials, SignupData, AuthError } from '../models/user.models';

const STORAGE_KEY_USERS   = 'soatrans_users';
const STORAGE_KEY_SESSION = 'soatrans_session';

@Injectable({ providedIn: 'root' })
export class AuthService {
  // ── State ────────────────────────────────────────────────────────────────
  readonly currentUser  = signal<UserProfile | null>(this.loadSession());
  readonly isLoggedIn   = computed(() => this.currentUser() !== null);
  readonly authError    = signal<AuthError>(null);
  readonly isLoading    = signal(false);

  // ── Login ─────────────────────────────────────────────────────────────────
  async login(credentials: LoginCredentials): Promise<boolean> {
    this.isLoading.set(true);
    this.authError.set(null);

    // Simule latence réseau (à remplacer par un vrai appel API)
    await this.delay(700);

    const users = this.loadUsers();
    const user  = users.find(
      u => u.email.toLowerCase() === credentials.email.toLowerCase()
    );

    // En production : vérifier le hash du mot de passe côté serveur
    // Ici on stocke un hash simple pour la démo (sha256-like via btoa)
    const stored = user ? this.getUserPassword(user.id) : null;
    const hash   = this.hashPassword(credentials.password);

    if (!user || stored !== hash) {
      this.authError.set('invalid_credentials');
      this.isLoading.set(false);
      return false;
    }

    this.saveSession(user);
    this.currentUser.set(user);
    this.isLoading.set(false);
    return true;
  }

  // ── Signup ────────────────────────────────────────────────────────────────
  async signup(data: SignupData): Promise<boolean> {
    this.isLoading.set(true);
    this.authError.set(null);

    await this.delay(700);

    // Validations
    if (!this.isValidEmail(data.email)) {
      this.authError.set('invalid_email');
      this.isLoading.set(false);
      return false;
    }
    if (data.password.length < 6) {
      this.authError.set('weak_password');
      this.isLoading.set(false);
      return false;
    }

    const users = this.loadUsers();
    if (users.find(u => u.email.toLowerCase() === data.email.toLowerCase())) {
      this.authError.set('email_taken');
      this.isLoading.set(false);
      return false;
    }

    const newUser: UserProfile = {
      id:        this.generateId(),
      email:     data.email.trim().toLowerCase(),
      firstName: data.firstName.trim(),
      lastName:  data.lastName.trim(),
      phone:     data.phone.trim(),
      gender:    data.gender,
      age:       data.age,
      createdAt: new Date().toISOString(),
    };

    // Sauvegarder utilisateur + mot de passe séparément
    users.push(newUser);
    this.saveUsers(users);
    this.saveUserPassword(newUser.id, this.hashPassword(data.password));

    this.saveSession(newUser);
    this.currentUser.set(newUser);
    this.isLoading.set(false);
    return true;
  }

  // ── Logout ────────────────────────────────────────────────────────────────
  logout(): void {
    localStorage.removeItem(STORAGE_KEY_SESSION);
    this.currentUser.set(null);
    this.authError.set(null);
  }

  // ── Update profile ────────────────────────────────────────────────────────
  updateProfile(updates: Partial<UserProfile>): void {
    const user = this.currentUser();
    if (!user) return;
    const updated = { ...user, ...updates };
    const users   = this.loadUsers().map(u => u.id === user.id ? updated : u);
    this.saveUsers(users);
    this.saveSession(updated);
    this.currentUser.set(updated);
  }

  // ── Change password ───────────────────────────────────────────────────────
  async changePassword(currentPassword: string, newPassword: string): Promise<boolean> {
    const user = this.currentUser();
    if (!user) return false;
    const stored = this.getUserPassword(user.id);
    if (stored !== this.hashPassword(currentPassword)) return false;
    this.saveUserPassword(user.id, this.hashPassword(newPassword));
    return true;
  }

  clearError(): void { this.authError.set(null); }

  // ── Error messages helper ─────────────────────────────────────────────────
  getErrorMessage(error: AuthError, lang = 'fr'): string {
    type MsgMap = Record<NonNullable<AuthError>, Record<string, string>>;
    const msgs: MsgMap = {
      invalid_credentials: {
        fr: 'Email ou mot de passe incorrect',
        en: 'Incorrect email or password',
        mg: 'Email na teny miafina diso',
        zh: '邮箱或密码不正确',
      },
      email_taken: {
        fr: 'Un compte existe déjà avec cet email',
        en: 'An account already exists with this email',
        mg: 'Misy kaonty sahady amin\'ity email ity',
        zh: '该邮箱已注册',
      },
      weak_password: {
        fr: 'Le mot de passe doit contenir au moins 6 caractères',
        en: 'Password must be at least 6 characters',
        mg: 'Ny teny miafina dia tsy maintsy manana litera 6 farafahakeliny',
        zh: '密码至少需要6个字符',
      },
      invalid_email: {
        fr: 'Adresse email invalide',
        en: 'Invalid email address',
        mg: 'Adiresy email tsy mety',
        zh: '无效的邮箱地址',
      },
      missing_fields: {
        fr: 'Veuillez remplir tous les champs obligatoires',
        en: 'Please fill in all required fields',
        mg: 'Fenoy ny saha rehetra ilaina',
        zh: '请填写所有必填字段',
      },
    };
    if (!error) return '';
    return msgs[error]?.[lang] ?? msgs[error]?.['fr'] ?? 'Erreur';
  }

  // ── Persistance ───────────────────────────────────────────────────────────
  private loadSession(): UserProfile | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SESSION);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  private saveSession(user: UserProfile): void {
    localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify(user));
  }

  private loadUsers(): UserProfile[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_USERS);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  private saveUsers(users: UserProfile[]): void {
    localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(users));
  }

  private saveUserPassword(userId: string, hash: string): void {
    localStorage.setItem('soatrans_pwd_' + userId, hash);
  }

  private getUserPassword(userId: string): string | null {
    return localStorage.getItem('soatrans_pwd_' + userId);
  }

  // ── Utilitaires ───────────────────────────────────────────────────────────
  // Hash simple (btoa) — en production utiliser bcrypt côté serveur
  private hashPassword(password: string): string {
    return btoa(encodeURIComponent(password + 'soatrans_salt_2025'));
  }

  private isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
