export interface UserProfile {
  id: string; email: string; firstName: string; lastName: string; phone: string; gender: string;
  createdAt: string; totpEnabled?: boolean; publicId?: string;
}
export interface LoginCredentials { email: string; password: string }
export interface SignupData { email: string; password: string; firstName: string; lastName: string; phone: string; gender: string }

export type AuthError =
  | 'invalid_credentials' | 'email_taken' | 'weak_password' | 'invalid_email' | 'missing_fields'
  | 'account_locked' | 'account_suspended' | 'invalid_code' | 'network' | 'unknown'
  | null;

/** Réservation affichée dans l'historique du client. */
export interface SavedBooking {
  id: string; userId: string; reference: string; createdAt: string;
  status: 'confirmed' | 'cancelled' | 'completed' | 'pending' | 'expired';
  from: string; to: string; date: string; departure: string; arrival: string; duration: string;
  busId: string; busName: string; busType: string;
  seats: string[]; passengers: SavedPassenger[];
  totalAmount: number; paymentMethod?: string;
  paymentStatus?: string; canCancel?: boolean; canChange?: boolean; accessToken?: string; refundPendingAmount?: number; refundedAmount?: number;
}
export interface SavedPassenger { firstName: string; lastName: string; phone: string; gender: string; seatNumber: string; ticketNumber?: string | null; status?: string }
