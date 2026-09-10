import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, Building2, CalendarDays, ChevronUp, HeartPulse, Mail, MapPin,
  Phone,
} from 'lucide-react';
import { motion, useAnimation, useScroll, useSpring, useTransform } from 'framer-motion';
import { useTheme } from '../../context/ThemeContext';
import { TransitionFlipExit } from '../../components/transitions/TransitionFlip';
import { isSupabaseConfigured, supabase } from '../../lib/supabaseClient';
import './landing-scroll.css';

function formatPublicDate(value) {
  if (!value) return 'Schedule to be announced';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Schedule to be announced';
  return parsed.toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/*  static content  */
const applicationChecklist = [
  { group: 'Hospital information', items: [
    'Licensed hospital or qualified healthcare facility details',
    'Complete facility address and official contact channels',
    'Authorized representative’s identity and work email',
    'Hospital logo and supporting accreditation documents',
  ]},
  { group: 'Partnership readiness', items: [
    'Commitment to verify patient eligibility and protect medical information',
    'A designated H-Representative who will manage requests',
    'Agreement to Donivra’s operational and data-handling requirements',
    'A reachable contact for partnership review and coordination',
  ]},
];

/*  helpers  */
function parseRgbChannels(hex, fallback = [184, 149, 90]) {
  const m = String(hex || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (m) return [parseInt(m[1].slice(0,2),16), parseInt(m[1].slice(2,4),16), parseInt(m[1].slice(4,6),16)];
  return fallback;
}

function goToHard(path) { window.location.assign(path); }

/*  canvas helpers  */
function setupHeroCanvas(canvas, getThemeRgb) {
  if (!canvas) return () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  let W = 0, H = 0, raf = 0;
  let strands = [];

  function resize() {
    W = canvas.offsetWidth || 1;
    H = canvas.offsetHeight || 1;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    strands = Array.from({ length: 60 }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      len: 80 + Math.random() * 160,
      wave: 6 + Math.random() * 18,
      phase: Math.random() * Math.PI * 2,
      speed: 0.003 + Math.random() * 0.006,
      op: 0.08 + Math.random() * 0.15,
      w: 0.6 + Math.random() * 1.5,
      primary: Math.random() < 0.35,
    }));
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const theme = getThemeRgb();
    const primaryRgba = `rgba(${theme.primaryRgb},`;
    const textRgba = `rgba(${theme.textRgb},`;

    strands.forEach(s => {
      s.phase += s.speed;
      ctx.beginPath();
      ctx.strokeStyle = s.primary ? `${primaryRgba}${s.op + 0.1})` : `${textRgba}${s.op})`;
      ctx.lineWidth = s.w;
      ctx.lineCap = 'round';
      for (let i = 0; i <= 20; i++) {
        const p = i / 20;
        const px = s.x + Math.sin(p * Math.PI * 2 + s.phase) * s.wave * (1 - p * 0.3);
        const py = s.y + p * s.len;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
      if (s.y + s.len > H + 20) { s.y = -s.len - 20; s.x = Math.random() * W; }
      s.y += 0.12;
    });
    raf = requestAnimationFrame(draw);
  }

  resize();
  draw();
  window.addEventListener('resize', resize, { passive: true });
  return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
}

function setupCtaCanvas(canvas, getThemeRgb) {
  if (!canvas) return () => {};
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  let W = 0, H = 0, raf = 0, hairs = [];

  function resize() {
    W = canvas.offsetWidth || 1;
    H = canvas.offsetHeight || 1;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hairs = Array.from({ length: 30 }, () => ({
      x: Math.random() * W, y0: -80,
      len: 120 + Math.random() * 200,
      wave: (Math.random() - 0.5) * 25,
      phase: Math.random() * Math.PI * 2,
      speed: 0.05 + Math.random() * 0.08,
      op: 0.15 + Math.random() * 0.25,
      w: 0.5 + Math.random() * 1.2,
      primary: Math.random() < 0.4,
    }));
  }

  function draw(ts) {
    const t = (ts || 0) * 0.001;
    ctx.clearRect(0, 0, W, H);
    const theme = getThemeRgb();
    const primaryRgba = `rgba(${theme.primaryRgb},`;
    const textRgba = `rgba(${theme.textRgb},`;

    hairs.forEach(h => {
      ctx.beginPath();
      ctx.strokeStyle = h.primary ? `${primaryRgba}${h.op + 0.1})` : `${textRgba}${h.op})`;
      ctx.lineWidth = h.w;
      for (let i = 0; i <= 14; i++) {
        const p = i / 14;
        const px = h.x + Math.sin(p * Math.PI + h.phase + t * h.speed) * h.wave * p;
        const py = h.y0 + p * h.len + (t * 25) % H;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
    });
    raf = requestAnimationFrame(draw);
  }

  resize();
  raf = requestAnimationFrame(draw);
  window.addEventListener('resize', resize, { passive: true });
  return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
}

/*  component  */
export default function LandingPage() {
  const { theme } = useTheme();

  /* theme tokens */
  const primaryColor   = String(theme?.primaryColor   || '#b8955a').trim();
  const primaryLight   = String(theme?.primaryColorLight || primaryColor).trim();
  const primaryDark    = String(theme?.primaryColorDark  || primaryColor).trim();
  const bgColor        = String(theme?.backgroundColor   || '#f5f0e8').trim();
  const textPrimary    = String(theme?.primaryTextColor   || '#0f0d0a').trim();
  const textSecondary  = String(theme?.secondaryTextColor || '#7a6f61').trim();
  const textTertiary   = String(theme?.tertiaryTextColor  || '#94a3b8').trim();
  const bodyFont       = String(theme?.secondaryFontFamily || theme?.selectedFont || theme?.fontFamily || 'DM Sans').trim();
  const headingFont    = String(theme?.selectedFont || theme?.fontFamily || 'Cormorant Garamond').trim();
  const brandName      = String(theme?.brandName    || 'Donivra').trim();
  const brandTagline   = String(theme?.brandTagline || 'Every Strand Counts').trim();

  const themeRgbRef = useRef({ primaryRgb: '184, 149, 90', textRgb: '15, 13, 10' });

  /* CSS variables injected on root div */
  const cssVars = useMemo(() => {
    const pRgb  = parseRgbChannels(primaryColor, [184,149,90]).join(', ');
    const bgRgb = parseRgbChannels(bgColor, [245,240,232]).join(', ');
    const txtRgb = parseRgbChannels(textPrimary, [15,13,10]).join(', ');
    
    themeRgbRef.current = { primaryRgb: pRgb, textRgb: txtRgb };

    return {
      '--color-primary':           primaryColor,
      '--color-primary-light':     primaryLight,
      '--color-primary-dark':      primaryDark,
      '--color-primary-rgb':       pRgb,
      '--color-bg':                bgColor,
      '--color-bg-rgb':            bgRgb,
      '--color-text-primary':      textPrimary,
      '--color-text-primary-rgb':  txtRgb,
      '--color-text-secondary':    textSecondary,
      '--color-text-tertiary':     textTertiary,
      '--font-sans':               `'${bodyFont}', DM Sans, sans-serif`,
      '--font-serif':              `'${headingFont}', Cormorant Garamond, serif`,
    };
  }, [primaryColor, primaryLight, primaryDark, bgColor, textPrimary, textSecondary, textTertiary, bodyFont, headingFont]);

  /* refs */
  const rootRef      = useRef(null);
  const heroCanvasRef = useRef(null);
  const ctaCanvasRef  = useRef(null);

  /* state */
  const [heroVis,    setHeroVis]    = useState(false);
  const [navScrolled, setNavScrolled] = useState(false);
  const [navMinimized, setNavMinimized] = useState(false);
  const [topHoverActive, setTopHoverActive] = useState(false);
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [openFaq,    setOpenFaq]    = useState(-1);
  const [publicContent, setPublicContent] = useState({
    metrics: {},
    upcoming_programs: [],
    partner_hospitals: [],
    updated_at: null,
  });
  const [publicContentStatus, setPublicContentStatus] = useState('loading');
  const topHoverStateRef = useRef(false);
  const lastScrollYRef = useRef(0);

  /* transitions */
  const [exitTransition, setExitTransition] = useState(null); // 'login' | 'apply' | null
  const pendingPathRef = useRef(null);
  const fadeControls = useAnimation();

  /* re-entry from login (back-to-landing) starts faded/zoomed */
  const incomingTransition = useMemo(() => {
    try {
      return typeof window !== 'undefined'
        ? sessionStorage.getItem('Donivra:incoming-transition') || ''
        : '';
    } catch { return ''; }
  }, []);
  const isReturningFromLogin = incomingTransition === 'back-from-login';

  useEffect(() => {
    let isCancelled = false;

    const fetchLandingContent = async () => {
      if (!isSupabaseConfigured || !supabase) {
        if (!isCancelled) setPublicContentStatus('unavailable');
        return;
      }
      const { data, error: contentError } = await supabase.rpc('get_public_landing_content');
      if (!isCancelled && !contentError && data) {
        setPublicContent(data);
        setPublicContentStatus('ready');
      } else if (!isCancelled) {
        setPublicContentStatus('unavailable');
      }
    };

    void fetchLandingContent();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isReturningFromLogin) {
      try { sessionStorage.removeItem('Donivra:incoming-transition'); } catch { /* ignore */ }
      fadeControls.start({
        opacity: 1,
        scale: 1,
        transition: { duration: 0.5, ease: [0.22, 0.61, 0.36, 1] },
      });
    }
  }, [isReturningFromLogin, fadeControls]);

  const handleNavigate = useCallback((path) => {
    if (exitTransition) return;
    if (path === '/login') {
      pendingPathRef.current = path;
      setExitTransition('login');
      fadeControls.start({
        opacity: 0,
        scale: 1.04,
        transition: { duration: 0.45, ease: [0.22, 0.61, 0.36, 1] },
      }).then(() => {
        sessionStorage.setItem('Donivra:incoming-transition', 'login');
        goToHard(path);
      });
    } else if (path === '/apply-partnership' || path === '/apply-event') {
      pendingPathRef.current = path;
      setExitTransition('apply');
    } else {
      goToHard(path);
    }
  }, [exitTransition, fadeControls]);

  const handleTransitionDone = useCallback(() => {
    const path = pendingPathRef.current;
    if (path) {
      sessionStorage.setItem('Donivra:incoming-transition', exitTransition || '');
      goToHard(path);
    }
  }, [exitTransition]);

  /* scroll-driven Apple-style effects */
  const { scrollY, scrollYProgress } = useScroll();
  const scrollProgressX = useSpring(scrollYProgress, { stiffness: 90, damping: 20, mass: 0.4 });
  const heroScale = useTransform(scrollY, [0, 600], [1, 0.92]);
  const heroOpacity = useTransform(scrollY, [0, 500], [1, 0]);
  const heroY = useTransform(scrollY, [0, 600], [0, -90]);
  const heroBgRotate = useTransform(scrollY, [0, 1000], [0, 8]);
  const heroBgScale = useTransform(scrollY, [0, 800], [1, 1.18]);

  /* smooth scroll */
  const smoothTo = useCallback((id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  const jumpToTop = useCallback(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, []);

  /* nav scroll */
  useEffect(() => {
    const onScroll = () => {
      const currentY = window.scrollY || 0;
      const canHoverReveal = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
      const previousY = lastScrollYRef.current;

      setNavScrolled(currentY > 40);
      setShowBackToTop(currentY > 420);

      if (!canHoverReveal || currentY < 100) {
        setNavMinimized(false);
      } else if (currentY < previousY) {
        // Bring navigation back immediately when the user starts scrolling up.
        setNavMinimized(false);
      } else if (currentY > previousY) {
        setNavMinimized(true);
      }

      lastScrollYRef.current = currentY;

    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /* hero reveal */
  useEffect(() => {
    const t = setTimeout(() => setHeroVis(true), 200);
    return () => clearTimeout(t);
  }, []);

  /* reveal minimized nav when cursor reaches top edge */
  useEffect(() => {
    const canHoverReveal = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (!canHoverReveal) {
      topHoverStateRef.current = false;
      setTopHoverActive(false);
      return () => {};
    }

    const onMouseMove = (event) => {
      const shouldReveal = event.clientY <= 24;
      if (shouldReveal !== topHoverStateRef.current) {
        topHoverStateRef.current = shouldReveal;
        setTopHoverActive(shouldReveal);
      }
    };

    const onLeaveWindow = (event) => {
      if (event.relatedTarget !== null) return;
      if (topHoverStateRef.current) {
        topHoverStateRef.current = false;
        setTopHoverActive(false);
      }
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseout', onLeaveWindow);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseout', onLeaveWindow);
    };
  }, []);

  /* canvas animations */
  useEffect(() => {
    const getThemeRgb = () => themeRgbRef.current;
    const c1 = setupHeroCanvas(heroCanvasRef.current, getThemeRgb);
    const c2 = setupCtaCanvas(ctaCanvasRef.current, getThemeRgb);
    return () => { c1(); c2(); };
  }, []);

  /* intersection observer - scroll reveals */
  useEffect(() => {
    if (!rootRef.current || typeof IntersectionObserver === 'undefined') return;
    const selector = '.eyebrow,.section-title,.section-lead,.about-card,.impact-card,.step,.req-item,.cta-title,.cta-sub,.cta-btns';
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('vis'); });
    }, { threshold: 0.12 });
    rootRef.current.querySelectorAll(selector).forEach(el => io.observe(el));
    return () => io.disconnect();
  }, []);

  const toggleFaq = useCallback(i => setOpenFaq(prev => (prev === i ? -1 : i)), []);
  const aboutCards = useMemo(() => ([
    {
      title: 'Purposeful Donations',
      body: 'We help turn qualified hair donations into responsibly produced wigs for patients experiencing medical hair loss.',
      icon: '01',
    },
    {
      title: 'Verified Care Network',
      body: 'Approved hospitals, trained staff, and specialists work through one traceable process with clear responsibilities.',
      icon: '02',
    },
    {
      title: 'Patient Privacy',
      body: 'Medical applications and documents are kept private and reviewed only by the patient’s selected hospital.',
      icon: '03',
    },
  ]), []);

  const trackCards = useMemo(() => ([
    {
      id: 'hospital',
      eyebrow: 'Hospital Track',
      title: 'Apply for a Donation Program',
      icon: 'hospital',
      body: 'Organizations and communities can propose a hair-donation program for formal review and coordination.',
      points: [
        'Complete the public program application and attach the requested documents',
        'Donivra staff validates the proposal and coordinates missing details',
        'An administrator makes the final decision before the program is published',
      ],
    },
  ]), []);

  const journeyCards = useMemo(() => ([
    { num: '01', title: 'Apply for a Program', detail: 'Submit a complete public application for a proposed hair-donation program.' },
    { num: '02', title: 'Staff Review', detail: 'Staff checks eligibility, documents, venue details, and schedule readiness.' },
    { num: '03', title: 'Admin Approval', detail: 'An administrator reviews the endorsed application and records the final decision.' },
    { num: '04', title: 'Program Delivery', detail: 'Approved programs move into attendee registration, receiving, quality checks, and reporting.' },
  ]), []);

  const faqItems = useMemo(() => ([
    {
      q: 'Who can apply for a Donivra program?',
      a: 'Organizations, hospitals, schools, and community groups may submit a program proposal. Every proposal is reviewed before approval.',
    },
    {
      q: 'How can a patient request support?',
      a: 'A patient views the approved partner hospitals, chooses one accepting applications, verifies an email by OTP, and submits the hospital’s required information. Patient accounts are used only in the Donivra mobile app.',
    },
    {
      q: 'Are patient medical details public?',
      a: 'No. Medical details and documents are private and are reviewed only by the H-Representative assigned to the selected hospital.',
    },
    {
      q: 'What happens after a program application is submitted?',
      a: 'Donivra sends a confirmation, staff reviews and coordinates the details, and an administrator makes the final approval or rejection decision.',
    },
    {
      q: 'How does a hospital become a partner?',
      a: 'The hospital submits its facility and authorized representative details. Donivra reviews the application before enabling hospital access.',
    },
    {
      q: 'How is donated hair tracked?',
      a: 'Eligible donations use waybill and QR records through receiving, quality review, bundling, wig production, stock, and release.',
    },
  ]), []);

  const dynamicMarqueeItems = useMemo(() => ([
    'Hair Donation Programs',
    'Partner Hospitals',
    'Patient Privacy',
    'Quality Verification',
    'Wig Production',
    'Hope in Every Strand',
  ]), []);

  const publicMetrics = [
    { label: 'Approved partner hospitals', value: publicContentStatus === 'ready' ? Number(publicContent?.metrics?.partner_hospitals || 0) : null },
    { label: 'Hospitals accepting applications', value: publicContentStatus === 'ready' ? Number(publicContent?.metrics?.open_patient_applications || 0) : null },
    { label: 'Approved donation programs', value: publicContentStatus === 'ready' ? Number(publicContent?.metrics?.approved_programs || 0) : null },
    { label: 'Wigs released', value: publicContentStatus === 'ready' ? Number(publicContent?.metrics?.released_wigs || 0) : null },
  ];
  const upcomingPrograms = Array.isArray(publicContent?.upcoming_programs) ? publicContent.upcoming_programs : [];
  const featuredHospitals = Array.isArray(publicContent?.partner_hospitals) ? publicContent.partner_hospitals : [];
  const marqueeDouble = [...dynamicMarqueeItems, ...dynamicMarqueeItems];

  return (
    <div className="landing-scroll-root" style={cssVars} ref={rootRef}>
      <motion.div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: '3px',
          transformOrigin: '0% 50%',
          scaleX: scrollProgressX,
          background: primaryColor,
          zIndex: 9000,
          pointerEvents: 'none',
        }}
        aria-hidden="true"
      />

      {/*  NAV  */}
      <nav
        id="topnav"
        className={[
          navScrolled ? 'scrolled' : '',
          navMinimized ? 'minimized' : '',
          navMinimized && topHoverActive ? 'peek' : '',
        ].filter(Boolean).join(' ')}
      >
        <button type="button" className={`nav-brand${heroVis ? ' vis' : ''}`} onClick={() => smoothTo('hero')}>
          {theme?.logoImage
            ? <img src={theme.logoImage} alt={`${brandName} logo`} className="nav-brand-image" />
            : null}
          <span className="nav-logo-text">{brandName}</span>
        </button>

        <div className={`nav-links${heroVis ? ' vis' : ''}`}>
          <a href="#about">About</a>
          <a href="#journey">How It Works</a>
          <a href="#programs">Programs</a>
          <a href="#partners">Partner Hospitals</a>
          <a href="#become-partner">Become a Partner</a>
          <a href="#faq">FAQ</a>
        </div>

        <div className={`nav-actions${heroVis ? ' vis' : ''}`}>
          <button type="button" className="nav-login" onClick={() => handleNavigate('/login')}>Login</button>
          <button type="button" className="nav-cta event-apply-cta" onClick={() => handleNavigate('/apply-event')}>Apply for Program</button>
        </div>
      </nav>

      <button
        type="button"
        className={`back-to-top${showBackToTop ? ' show' : ''}`}
        onClick={jumpToTop}
        aria-label="Back to top"
        title="Back to top"
      >
        <ChevronUp size={18} />
      </button>

    <TransitionFlipExit
      trigger={exitTransition === 'apply'}
      onComplete={handleTransitionDone}
    >
    <motion.div
      initial={isReturningFromLogin ? { opacity: 0, scale: 1.04 } : { opacity: 1, scale: 1 }}
      animate={fadeControls}
      style={{ transformOrigin: 'center center', willChange: 'transform, opacity' }}
    >

      {/*  HERO  */}
      <section id="hero">
        <motion.canvas
          ref={heroCanvasRef}
          className="landing-stars"
          aria-hidden="true"
          style={{ rotate: heroBgRotate, scale: heroBgScale }}
        />

        <motion.div
          className="hero-inner"
          style={{ scale: heroScale, opacity: heroOpacity, y: heroY }}
        >
          <p className={`hero-badge${heroVis ? ' vis' : ''}`}>{brandTagline}</p>

          <h1 className="hero-title">
            <span className={`line${heroVis ? ' vis' : ''}`}>
              <span className="line-inner">Every Strand</span>
            </span>
            <span className={`line${heroVis ? ' vis' : ''}`} style={{ transitionDelay: '0.14s' }}>
              <span className="line-inner">Carries <span>Hope</span></span>
            </span>
            <span className={`line${heroVis ? ' vis' : ''}`} style={{ transitionDelay: '0.28s' }}>
              <span className="line-inner">Forward</span>
            </span>
          </h1>

          <p className={`hero-sub${heroVis ? ' vis' : ''}`}>
            {brandName} connects donors, communities, specialists, and trusted hospitals to turn
            qualified hair donations into dignified patient support.
          </p>

          <div className={`hero-ctas${heroVis ? ' vis' : ''}`}>
            <button type="button" className="btn-primary event-apply-cta" onClick={() => handleNavigate('/apply-event')}>
              Apply for a Program <ArrowRight size={15} />
            </button>
            <button type="button" className="btn-primary" onClick={() => handleNavigate('/partner-hospitals')}>
              Become a Donivra Patient <ArrowRight size={15} />
            </button>
            <button type="button" className="btn-primary" onClick={() => handleNavigate('/apply-partnership')}>
              Become a Partner <ArrowRight size={15} />
            </button>
          </div>
        </motion.div>

        <div className="scroll-hint">Scroll</div>
      </section>

      {/*  MARQUEE  */}
      <div className="marquee-band" aria-hidden="true">
        <div className="m-track">
          {marqueeDouble.map((item, i) => (
            <span className="m-item" key={i}>{item}<span className="m-dot" /></span>
          ))}
        </div>
        <div className="m-track">
          {marqueeDouble.map((item, i) => (
            <span className="m-item" key={i}>{item}<span className="m-dot" /></span>
          ))}
        </div>
      </div>

      {/*  ABOUT  */}
      <section id="about">
        <div className="container">
          <p className="eyebrow">About {brandName}</p>
          <h2 className="section-title">Everything You Need<br />To Know About <em>Us</em></h2>
          <p className="section-lead">
            A care-focused platform that turns fragmented tasks into a trusted, transparent
            workflow - from request to release.
          </p>
          <div className="about-grid">
            {aboutCards.map(item => (
              <article className="about-card" key={item.title}>
                <div className="card-icon">{item.icon}</div>
                <h3 className="card-title">{item.title}</h3>
                <p className="card-body">{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/*  HOW IT WORKS  */}
      <section id="journey">
        <div className="container">
          <p className="eyebrow">How It Works</p>
          <h2 className="section-title">A Clear Path from<br /><em>Application to Impact</em></h2>
          <p className="section-lead">Every public program follows a reviewed and traceable process before collection begins.</p>
          <div className="steps-wrap">
            {journeyCards.map((step) => (
              <article className="step" key={step.title}>
                <div className="step-num">{step.num}</div>
                <h3 className="step-title">{step.title}</h3>
                <p className="step-detail">{step.detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/*  PROGRAM APPLICATION  */}
      <section id="programs">
        <div className="container">
          <p className="eyebrow">Program Application</p>
          <h2 className="section-title">Bring a Hair Donation<br /><em>Program to Your Community</em></h2>
          <p className="section-lead">
            Propose a program with a real venue, schedule, organizer, and supporting documents. Submission starts a review—it is not automatic approval.
          </p>
          <div className="impact-grid" style={{ gridTemplateColumns: 'repeat(1, 1fr)' }}>
            {trackCards.map((track) => (
              <article className="impact-card" key={track.id}>
                <div
                  className="impact-num"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
                >
                  <HeartPulse size={14} />
                  {track.eyebrow} - {track.title}
                </div>
                <h3 className="impact-title">{track.title}</h3>
                <p className="impact-body">{track.body}</p>
                <ul style={{ marginTop: '1.25rem', display: 'grid', gap: '0.5rem', listStyle: 'none', padding: 0 }}>
                  {track.points.map((point) => (
                    <li
                      key={point}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '0.6rem',
                        fontSize: '0.92rem',
                        color: 'var(--color-text-secondary)',
                        lineHeight: 1.6,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          flex: '0 0 auto',
                          marginTop: '0.55rem',
                          width: '6px',
                          height: '6px',
                          borderRadius: '999px',
                          background: 'var(--color-primary)',
                        }}
                      />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <div style={{ marginTop: '2.5rem', display: 'flex', justifyContent: 'center' }}>
            <button type="button" className="btn-primary event-apply-cta" onClick={() => handleNavigate('/apply-event')}>
              Start Program Application <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </section>

      {/*  LIVE IMPACT  */}
      <section id="impact">
        <div className="container">
          <p className="eyebrow">Live Donivra Network</p>
          <h2 className="section-title">Real Progress,<br /><em>Safely Summarized</em></h2>
          <p className="section-lead">These totals come from approved operational records. No patient or applicant information is exposed.</p>
          <div className="impact-grid landing-metrics-grid">
            {publicMetrics.map((metric) => (
              <article className="impact-card landing-metric" key={metric.label}>
                <div className="landing-metric-value">{metric.value === null ? '—' : metric.value.toLocaleString('en-PH')}</div>
                <p className="impact-body">{metric.label}</p>
              </article>
            ))}
          </div>
          {publicContent?.updated_at && <p className="landing-live-note">Live summary updated {formatPublicDate(publicContent.updated_at)}</p>}
        </div>
      </section>

      <section id="upcoming-programs" style={{ background: 'var(--color-bg,#f5f0e8)', padding: '4rem 2rem 2rem' }}>
        <div className="container">
          <p className="eyebrow vis">Approved Programs</p>
          <h2 className="section-title vis">Upcoming <em>Donation Programs</em></h2>
          <p className="section-lead vis">
            Only administrator-approved public programs appear here. Schedules may still be updated by the organizing team.
          </p>
          {upcomingPrograms.length > 0 ? (
            <div className="impact-grid" style={{ marginTop: 0 }}>
              {upcomingPrograms.map((program) => (
                <article className="impact-card vis" key={program.id}>
                  <div className="impact-num"><CalendarDays size={14} /> {formatPublicDate(program.start_date)}</div>
                  <h3 className="impact-title" style={{ fontSize: '1.2rem' }}>{program.name}</h3>
                  <p className="impact-body"><MapPin size={14} className="landing-inline-icon" /> {[program.venue, program.city, program.province].filter(Boolean).join(', ') || 'Venue to be announced'}</p>
                </article>
              ))}
            </div>
          ) : (
            <article className="impact-card vis">
              <div className="impact-num">Program Calendar</div>
              <h3 className="impact-title" style={{ fontSize: '1.1rem' }}>{publicContentStatus === 'unavailable' ? 'Live calendar temporarily unavailable' : 'No upcoming approved program yet'}</h3>
              <p className="impact-body">{publicContentStatus === 'unavailable' ? 'Please check again later.' : 'New approved schedules will appear here automatically.'}</p>
            </article>
          )}
        </div>
      </section>

      {/*  PARTNER HOSPITALS  */}
      <section id="partners">
        <div className="container">
          <p className="eyebrow">Partner Hospitals</p>
          <h2 className="section-title">Care Coordinated with<br /><em>Trusted Hospitals</em></h2>
          <p className="section-lead">Patients can review approved hospitals and their requirements here. Patient sign-in remains exclusively in the mobile application.</p>
          <div className="landing-partner-grid">
            {featuredHospitals.length > 0 ? featuredHospitals.map((hospital) => (
              <article className="landing-partner-card" key={hospital.id}>
                <div className="landing-partner-icon"><Building2 size={21} /></div>
                <div>
                  <h3>{hospital.name}</h3>
                  <p><MapPin size={13} /> {hospital.location || 'Location not published'}</p>
                  <span className={hospital.applications_open ? 'is-open' : ''}>{hospital.applications_open ? 'Accepting patient applications' : 'Applications currently closed'}</span>
                </div>
              </article>
            )) : <article className="landing-partner-card"><div className="landing-partner-icon"><Building2 size={21} /></div><div><h3>Partner directory</h3><p>Approved hospitals will appear here automatically.</p></div></article>}
          </div>
          <div className="landing-section-actions">
            <button type="button" className="btn-primary" onClick={() => handleNavigate('/partner-hospitals')}>Become a Donivra Patient <ArrowRight size={15} /></button>
          </div>
        </div>
      </section>

      {/*  BECOME A PARTNER  */}
      <section id="become-partner">
        <div className="container">
          <p className="eyebrow">Become a Partner</p>
          <h2 className="section-title">Join the Hospital<br /><em>Care Network</em></h2>
          <p className="section-lead">
            Partnership is reviewed before access is granted. Prepare accurate facility and representative information to help Donivra validate your application.
          </p>
          {applicationChecklist.map((group, idx) => (
            <div
              key={group.group}
              style={{
                marginBottom: '2rem',
                paddingTop: idx === 0 ? 0 : '2rem',
                borderTop: idx === 0
                  ? 'none'
                  : '1px solid rgba(var(--color-primary-rgb, 184, 149, 90), 0.18)',
              }}
            >
              <p
                className="eyebrow"
                style={{ marginTop: 0, marginBottom: '1rem', opacity: 0.85 }}
              >
                {group.group}
              </p>
              <div className="req-grid">
                {group.items.map(req => (
                  <div className="req-item" key={req}>
                    <div className="req-check" aria-hidden="true">
                      <svg viewBox="0 0 12 12" strokeWidth="2.5"><polyline points="2,6 5,9 10,3" /></svg>
                    </div>
                    <span>{req}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary event-apply-cta" onClick={() => handleNavigate('/apply-partnership')}>
              Apply to Become a Partner <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </section>

      {/*  FAQ  */}
      <section id="faq">
        <div className="container">
          <p className="eyebrow">FAQ</p>
          <h2 className="section-title">Frequently Asked<br /><em>Questions</em></h2>
          <div className="faq-list">
            {faqItems.map((faq, i) => (
              <article className={`faq-item vis${openFaq === i ? ' open' : ''}`} key={faq.q}>
                <button type="button" className="faq-q" onClick={() => toggleFaq(i)}>
                  <span>{faq.q}</span>
                  <span className="faq-icon">
                    <svg viewBox="0 0 10 10"><polyline points="2,3 5,7 8,3" /></svg>
                  </span>
                </button>
                <div className="faq-body"><p>{faq.a}</p></div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/*  CTA  */}
      <section id="cta">
        <canvas ref={ctaCanvasRef} className="landing-stars" aria-hidden="true" />
        <div className="cta-inner container">
          <h2 className="cta-title">Ready to Make a<br /><em>Difference?</em></h2>
          <p className="cta-sub">
            Organize a verified donation program, apply for patient assistance, or help your hospital join Donivra.
          </p>
          <div className="cta-btns">
            <button type="button" className="btn-primary event-apply-cta" onClick={() => handleNavigate('/apply-event')}>
              Apply for a Program <ArrowRight size={15} />
            </button>
            <button type="button" className="btn-outline" onClick={() => handleNavigate('/partner-hospitals')}>
              Become a Donivra Patient
            </button>
          </div>
        </div>
      </section>

      {/*  FOOTER  */}
      <footer id="contact">
        <div className="footer-inner">
          <div>
            <div className="footer-brand">{brandName}</div>
            <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', marginTop: '0.5rem', maxWidth: '300px', lineHeight: 1.7 }}>
              {brandTagline}. Compassionate, ethical, and collaborative support systems.
            </p>
          </div>
          <div className="footer-links">
            <a href="#about">About</a>
            <a href="#journey">How It Works</a>
            <a href="#programs">Programs</a>
            <a href="#impact">Impact</a>
            <a href="#partners">Partner Hospitals</a>
            <a href="#become-partner">Become a Partner</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="footer-contact">
            <span><Mail size={14} /> donivraproject@gmail.com</span>
            <span><Phone size={14} /> +63 919 399 9824</span>
            <span><MapPin size={14} /> Angat, Bulacan, Philippines</span>
          </div>
        </div>
      </footer>
    </motion.div>
    </TransitionFlipExit>
    </div>
  );
}



