import React from 'react';
import { Outlet } from 'react-router-dom';
import './AppLayout.css';

const AppLayout = ({ children }) => <div className="layout-wrapper"><Outlet />{children}</div>;

export default AppLayout;
