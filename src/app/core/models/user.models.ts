export interface UserProfile {
  id:        string;
  email:     string;
  firstName: string;
  lastName:  string;
  phone:     string;
  gender:    string;
  age:       number;
  createdAt: string;
}

export interface LoginCredentials {
  email:    string;
  password: string;
}

export interface SignupData {
  email:     string;
  password:  string;
  firstName: string;
  lastName:  string;
  phone:     string;
  gender:    string;
  age:       number;
}

export type AuthError =
  | 'invalid_credentials'
  | 'email_taken'
  | 'weak_password'
  | 'invalid_email'
  | 'missing_fields'
  | null;

// ─── Historique des réservations ─────────────────────────────────────────────
export interface SavedBooking {
  id:          string;
  userId:      string;
  reference:   string;
  createdAt:   string;
  status:      'confirmed' | 'cancelled' | 'completed';
  // Trajet
  from:        string;
  to:          string;
  date:        string;
  departure:   string;
  arrival:     string;
  duration:    string;
  // Véhicule
  busId:       string;
  busName:     string;
  busType:     string;
  // Sièges & passagers
  seats:       string[];
  passengers:  SavedPassenger[];
  // Paiement
  totalAmount: number;
  paymentMethod?: string;
}

export interface SavedPassenger {
  firstName:  string;
  lastName:   string;
  age:        number;
  gender:     string;
  seatNumber: string;
}
