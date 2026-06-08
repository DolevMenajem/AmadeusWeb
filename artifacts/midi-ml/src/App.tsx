import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import Home from "@/pages/home";

import Extend from "@/pages/extend";
import Transform from "@/pages/transform";
import Evaluate from "@/pages/evaluate";
import LiveExtend from "@/pages/live";
import Jobs from "@/pages/jobs";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/extend" component={Extend} />
        <Route path="/transform" component={Transform} />
        <Route path="/evaluate" component={Evaluate} />
        <Route path="/live" component={LiveExtend} />
        <Route path="/jobs" component={Jobs} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.add('dark');
  }
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
