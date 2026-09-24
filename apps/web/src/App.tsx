import { Navigate, Route, Routes } from 'react-router';
import { BillsPage } from './features/bills/BillsPage.jsx';
import { InsightsPage } from './features/insights/InsightsPage.jsx';
import { ProjectPage } from './features/projects/ProjectPage.jsx';
import { ProjectsPage } from './features/projects/ProjectsPage.jsx';
import { ReportsPage } from './features/reporting/ReportsPage.jsx';
import { TransactionsPage } from './features/transactions/TransactionsPage.jsx';

export const App = () => (
  <Routes>
    <Route path="/" element={<Navigate to="/transactions" replace />} />
    <Route path="/transactions" element={<TransactionsPage />} />
    <Route path="/bills" element={<BillsPage />} />
    <Route path="/reports" element={<Navigate to="/reports/categories" replace />} />
    <Route path="/reports/categories" element={<ReportsPage />} />
    <Route path="/projects" element={<ProjectsPage />} />
    <Route path="/projects/:id" element={<ProjectPage />} />
    <Route path="/insights" element={<InsightsPage />} />
  </Routes>
);
