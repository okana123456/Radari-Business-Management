import { Link, Route, Routes } from 'react-router-dom'

function Landing() {
  return (
    <main className="landing">
      <nav><strong>Radari POS</strong><Link to="/signup">Create account</Link></nav>
      <section className="hero">
        <span className="eyebrow">Built for Kenyan businesses</span>
        <h1>See every sale. Know every stock level.</h1>
        <p>Run sales, stock, expenses and business reports from any device for KSh 1,500 every 30 days.</p>
        <Link className="primary" to="/signup">Start using Radari</Link>
      </section>
    </main>
  )
}

function Signup() {
  return (
    <main className="centered">
      <section className="card">
        <span className="eyebrow">Create your business account</span>
        <h1>Start with Radari POS</h1>
        <p>The secure signup and M-Pesa activation form will connect here after your Supabase project is ready.</p>
        <Link className="secondary" to="/">Back</Link>
      </section>
    </main>
  )
}

export default function App() {
  return <Routes><Route path="/" element={<Landing />} /><Route path="/signup" element={<Signup />} /></Routes>
}

