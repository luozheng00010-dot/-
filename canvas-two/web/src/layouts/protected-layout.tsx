import { Outlet } from "react-router-dom";
import { AuthGate } from "@/components/layout/auth-gate";
import UserLayout from "@/layouts/user-layout";

export default function ProtectedLayout() {
    return <AuthGate><UserLayout><Outlet /></UserLayout></AuthGate>;
}
