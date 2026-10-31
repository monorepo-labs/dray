import { Closing } from "@/components/home/Closing";
import { Everywhere } from "@/components/home/Everywhere";
import { Faq } from "@/components/home/Faq";
import { Features } from "@/components/home/Features";
import { Hero } from "@/components/home/Hero";
import { Island } from "@/components/home/Island";
import { Orchestrate } from "@/components/home/Orchestrate";
import { Testimonials } from "@/components/home/Testimonials";

export default function Home() {
  return (
    <div className="min-h-screen overflow-x-clip bg-black font-inter text-white antialiased">
      <Hero />
      <main>
        <Orchestrate />
        <Everywhere />
        <Features />
        <Island />
        <Testimonials />
        <Faq />
      </main>
      <Closing />
    </div>
  );
}