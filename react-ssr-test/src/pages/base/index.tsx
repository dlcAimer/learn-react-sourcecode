import '@/css/index.css';

import * as React from 'react';

import Content from './content';
import SideBar from './sideBar';

function Base() {
  return (
    <div className='w-screen h-screen p-2 flex flex-col justify-start items-center'>
      <main className='w-full flex-1 flex flex-row justify-between items-center'>
        <SideBar />
        <Content />
      </main>
    </div>
  );
}

// function Base() {
//   if (process.env.BROWSER) {
//     return (
//       <div className='App'>
//         <div>client</div>
//       </div>
//     );
//   }

//   return (
//     <div className='App'>
//       <p>server</p>
//     </div>
//   );
// }

export default Base;
