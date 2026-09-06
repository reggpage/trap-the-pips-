import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from '@/components/layout/AppShell';
import RequireAuth from '@/guards/RequireAuth';
import RequireRole from '@/guards/RequireRole';
import WaLogin from '@/routes/auth/WaLogin';
import BusinessSignup from '@/routes/auth/BusinessSignup';
import WhatsAppAuth from '@/routes/auth/WhatsAppAuth';
import ClaimsInbox from '@/routes/claims/ClaimsInbox';
import Landing from '@/routes/marketing/Landing';
import ProjectsList from '@/routes/projects/ProjectsList';
import NewProject from '@/routes/projects/NewProject';
import EditProject from '@/routes/projects/EditProject';
import ProjectDetail from '@/routes/projects/ProjectDetail';
import ReceiptsPage from '@/routes/receipts/ReceiptsPage';
import ManualReceipt from '@/routes/receipts/ManualReceipt';
import Dashboard from '@/routes/dashboard/Dashboard';
import InvoicesPage from '@/routes/invoices/InvoicesPage';
import InvoiceEditor from '@/routes/invoices/InvoiceEditor';
import PublicInvoice from '@/routes/invoices/PublicInvoice';
import PettyCashPage from '@/routes/pettyCash/PettyCashPage';
import SettingsPage from '@/routes/settings/SettingsPage';
import BillingPage from '@/routes/billing/BillingPage';
import NotificationsPage from '@/routes/notifications/NotificationsPage';
import RetirementsPage from '@/routes/retirements/RetirementsPage';
import ReimbursementsPage from '@/routes/reimbursements/ReimbursementsPage';
import DailyRecordsPage from '@/routes/dailyRecords/DailyRecordsPage';
import ProductsPage from '@/routes/products/ProductsPage';
import ScanPage from '@/routes/products/ScanPage';
import SellPage from '@/routes/products/SellPage';
import InstallPromptBanner from '@/components/pwa/InstallPromptBanner';

export default function App() {
  return (
    <>
      <Routes>
      {/* Public routes */}
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<WhatsAppAuth mode="login" />} />
      <Route path="/forgot-password" element={<Navigate to="/login" replace />} />
      {/* Spends a one-shot WhatsApp login token and starts a session. Public
          because the token is the credential; it lives 5 minutes and works once. */}
      <Route path="/wa-login" element={<WaLogin />} />
      <Route path="/signup" element={<BusinessSignup />} />
      {/* Retired public entry points never expose the old company directory or
          shared-password flow. Existing links land on WhatsApp onboarding. */}
      <Route path="/find-company" element={<Navigate to="/signup" replace />} />
      <Route path="/supplier-claims" element={<Navigate to="/login" replace />} />
      <Route path="/join/:token" element={<Navigate to="/signup" replace />} />
      {/* Public, no-login invoice view opened by the client via secure token. */}
      <Route path="/public/invoices/:token" element={<PublicInvoice />} />

      {/* Authed app */}
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />

        <Route path="/projects" element={<ProjectsList />} />
        <Route
          path="/projects/new"
          element={
            <RequireRole allowed={['owner']}>
              <NewProject />
            </RequireRole>
          }
        />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route
          path="/projects/:id/edit"
          element={
            <RequireRole allowed={['owner']}>
              <EditProject />
            </RequireRole>
          }
        />

        <Route path="/receipts" element={<ReceiptsPage />} />
        <Route path="/receipts/new" element={<ManualReceipt />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/retirements" element={<RetirementsPage />} />
        <Route path="/reimbursements" element={<ReimbursementsPage />} />
        <Route path="/daily-records" element={<DailyRecordsPage />} />
        <Route path="/products" element={<ProductsPage />} />
        <Route path="/scan" element={<ScanPage />} />
        <Route path="/sell" element={<SellPage />} />
        <Route
          path="/claims"
          element={
            <RequireRole allowed={['owner', 'accountant']}>
              <ClaimsInbox />
            </RequireRole>
          }
        />

        <Route
          path="/invoices"
          element={
            <RequireRole allowed={['owner', 'accountant']}>
              <InvoicesPage />
            </RequireRole>
          }
        />
        <Route
          path="/invoices/:id/edit"
          element={
            <RequireRole allowed={['owner', 'accountant']}>
              <InvoiceEditor />
            </RequireRole>
          }
        />
        <Route
          path="/petty-cash"
          element={
            <RequireRole allowed={['owner', 'accountant']}>
              <PettyCashPage />
            </RequireRole>
          }
        />

        <Route path="/settings" element={<SettingsPage />} />
        {/* Billing is the owner's business: a worker who guesses this URL is
            turned away here, and RLS turns them away again underneath. */}
        <Route
          path="/billing"
          element={(
            <RequireRole allowed={['owner']}>
              <BillingPage />
            </RequireRole>
          )}
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <InstallPromptBanner />
    </>
  );
}
