import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(
  (() => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    return root;
  })(),
).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
