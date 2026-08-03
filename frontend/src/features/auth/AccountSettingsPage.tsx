import React, { useState, useEffect } from 'react';
import PageHeader from '../common/PageHeader';
import { useAuth } from './AuthContext';

function StatusBadge({ verified }: { verified: boolean }) {
  return (
    <span className={`lf-pill ${verified ? 'lf-pill-on' : ''}`}>
      {verified ? '\u2713 Verified' : 'Not verified'}
    </span>
  );
}

export default function AccountSettingsPage() {
  const { user, updateProfile, changePassword, logout } = useAuth();

  // Profile form state
  const [fullName, setFullName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [profileError, setProfileError] = useState('');
  const [profileSuccess, setProfileSuccess] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);

  // Password form state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  useEffect(() => {
    if (user) {
      setFullName(user.fullName || '');
      setBusinessName(user.businessName || '');
      setWhatsappNumber(user.whatsappNumber || '');
    }
  }, [user]);

  async function handleProfileUpdate(e: React.FormEvent) {
    e.preventDefault();
    setProfileError('');
    setProfileSuccess('');
    if (!fullName.trim() || !businessName.trim()) {
      setProfileError('Full Name and Business Name are required.');
      return;
    }
    setProfileLoading(true);
    try {
      await updateProfile({
        fullName: fullName.trim(),
        businessName: businessName.trim(),
        whatsappNumber: whatsappNumber.trim(),
      });
      setProfileSuccess('Profile updated successfully.');
    } catch (err: any) {
      setProfileError(err?.message || 'Update failed.');
    } finally {
      setProfileLoading(false);
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');
    if (!currentPassword || !newPassword) {
      setPasswordError('All fields are required.');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('New password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }
    setPasswordLoading(true);
    const ok = await changePassword(currentPassword, newPassword);
    setPasswordLoading(false);
    if (ok) {
      setPasswordSuccess('Password changed successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
    } else {
      setPasswordError('Current password is incorrect.');
    }
  }

  if (!user) {
    return (
      <div className="lf-content">
        <PageHeader title="Account Settings" />
        <div className="lf-empty">Please sign in to view your account settings.</div>
      </div>
    );
  }

  return (
    <div className="lf-content">
      <PageHeader title="Account Settings" />

      <div className="auth-settings-grid">
        {/* Profile Card */}
        <div className="lf-card auth-settings-card">
          <div className="auth-settings-header">
            <h2 className="auth-settings-title">Profile</h2>
            <p className="auth-settings-desc">Update your personal and business information.</p>
          </div>
          <form onSubmit={handleProfileUpdate} className="auth-settings-form" noValidate>
            <div className="auth-settings-row">
              <div className="auth-settings-field">
                <label className="auth-label">Full Name</label>
                <input
                  type="text"
                  className="auth-input"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </div>
              <div className="auth-settings-field">
                <label className="auth-label">Business Name</label>
                <input
                  type="text"
                  className="auth-input"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                />
              </div>
            </div>
            <div className="auth-settings-row">
              <div className="auth-settings-field">
                <label className="auth-label">Email</label>
                <input
                  type="email"
                  className="auth-input auth-input-readonly"
                  value={user.email}
                  readOnly
                  title="Email cannot be changed"
                />
                <StatusBadge verified={user.emailVerified} />
              </div>
              <div className="auth-settings-field">
                <label className="auth-label">WhatsApp Number</label>
                <input
                  type="tel"
                  className="auth-input"
                  value={whatsappNumber}
                  onChange={(e) => setWhatsappNumber(e.target.value)}
                />
              </div>
            </div>
            {profileError && <div className="auth-error">{profileError}</div>}
            {profileSuccess && <div className="auth-success">{profileSuccess}</div>}
            <button type="submit" className="auth-btn-primary" disabled={profileLoading}>
              {profileLoading ? 'Saving…' : 'Update profile'}
            </button>
          </form>
        </div>

        {/* Password Card */}
        <div className="lf-card auth-settings-card">
          <div className="auth-settings-header">
            <h2 className="auth-settings-title">Change Password</h2>
            <p className="auth-settings-desc">Keep your account secure with a strong password.</p>
          </div>
          <form onSubmit={handlePasswordChange} className="auth-settings-form" noValidate>
            <div className="auth-settings-field">
              <label className="auth-label">Current password</label>
              <input
                type="password"
                className="auth-input"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="auth-settings-row">
              <div className="auth-settings-field">
                <label className="auth-label">New password</label>
                <input
                  type="password"
                  className="auth-input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="auth-settings-field">
                <label className="auth-label">Confirm new password</label>
                <input
                  type="password"
                  className="auth-input"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                />
              </div>
            </div>
            {passwordError && <div className="auth-error">{passwordError}</div>}
            {passwordSuccess && <div className="auth-success">{passwordSuccess}</div>}
            <button type="submit" className="auth-btn-primary" disabled={passwordLoading}>
              {passwordLoading ? 'Updating…' : 'Change password'}
            </button>
          </form>
        </div>

        {/* Danger Zone */}
        <div className="lf-card auth-settings-card auth-settings-danger">
          <div className="auth-settings-header">
            <h2 className="auth-settings-title">Session</h2>
            <p className="auth-settings-desc">Sign out of your account on this device.</p>
          </div>
          <button className="auth-btn-danger" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
