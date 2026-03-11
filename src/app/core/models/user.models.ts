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
