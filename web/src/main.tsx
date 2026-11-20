import { createRoot } from 'react-dom/client';
import { App } from './App';
import { UndoToast } from './undo';
import './styles.css';

// Плашка «Отменить» живёт вне экранов: форма операции закрывается сразу после сохранения
createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <UndoToast />
  </>,
);
