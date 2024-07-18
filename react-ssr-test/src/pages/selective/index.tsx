import '@/css/index.css';

import * as React from 'react';

const Content = React.lazy(() => import('./content'))
const SideBar = React.lazy(() => (
  new Promise<{ default: React.FC }>((resolve, reject) => {
    setTimeout(() => {
      const module = import('./sideBar');
      resolve(module);
    }, 5000);
  })
))

function Selective() {
  return (
    <div className='w-screen h-screen p-2 flex flex-col justify-start items-center'>
      <main className='w-full flex-1 flex flex-row justify-between items-center'>
        <React.Suspense fallback={<div>Loading SideBar!</div>}>
          <SideBar />
        </React.Suspense>
        <React.Suspense fallback={<div>Loading Content!</div>}>
          <Content />
        </React.Suspense>
      </main>
    </div>
  );
}

export default Selective;
